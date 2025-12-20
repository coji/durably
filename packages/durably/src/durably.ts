import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import type { z } from 'zod'
import {
  type AnyEventInput,
  type EventListener,
  type EventType,
  type Unsubscribe,
  createEventEmitter,
} from './events'
import {
  type JobDefinition,
  type JobFunction,
  type JobHandle,
  createJobHandle,
  createJobRegistry,
} from './job'
import { runMigrations } from './migrations'
import type { Database } from './schema'
import { type Storage, createKyselyStorage } from './storage'
import { createWorker } from './worker'

/**
 * Options for creating a Durably instance
 */
export interface DurablyOptions {
  dialect: Dialect
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  pollingInterval: 1000,
  heartbeatInterval: 5000,
  staleThreshold: 30000,
} as const

/**
 * Durably instance
 */
export interface Durably {
  /**
   * Run database migrations
   * This is idempotent and safe to call multiple times
   */
  migrate(): Promise<void>

  /**
   * Get the underlying Kysely database instance
   * Useful for testing and advanced use cases
   */
  readonly db: Kysely<Database>

  /**
   * Storage layer for database operations
   */
  readonly storage: Storage

  /**
   * Register an event listener
   * @returns Unsubscribe function
   */
  on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe

  /**
   * Emit an event (auto-assigns timestamp and sequence)
   */
  emit(event: AnyEventInput): void

  /**
   * Define a job
   */
  defineJob<
    TName extends string,
    TInputSchema extends z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny | undefined = undefined,
  >(
    definition: JobDefinition<TName, TInputSchema, TOutputSchema>,
    fn: JobFunction<z.infer<TInputSchema>, TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void>
  ): JobHandle<TName, z.infer<TInputSchema>, TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void>

  /**
   * Start the worker polling loop
   */
  start(): void

  /**
   * Stop the worker after current run completes
   */
  stop(): Promise<void>

  // TODO: Add more methods in later phases
  // use()
  // getRun()
  // getRuns()
  // retry()
}

/**
 * Create a Durably instance
 */
export function createDurably(options: DurablyOptions): Durably {
  const config = {
    pollingInterval: options.pollingInterval ?? DEFAULTS.pollingInterval,
    heartbeatInterval: options.heartbeatInterval ?? DEFAULTS.heartbeatInterval,
    staleThreshold: options.staleThreshold ?? DEFAULTS.staleThreshold,
  }

  const db = new Kysely<Database>({ dialect: options.dialect })
  const storage = createKyselyStorage(db)
  const eventEmitter = createEventEmitter()
  const jobRegistry = createJobRegistry()
  const worker = createWorker(config, storage, eventEmitter, jobRegistry)

  // Track migration state for idempotency
  let migrating: Promise<void> | null = null
  let migrated = false

  return {
    db,
    storage,
    on: eventEmitter.on,
    emit: eventEmitter.emit,
    start: worker.start,
    stop: worker.stop,

    defineJob<
      TName extends string,
      TInputSchema extends z.ZodTypeAny,
      TOutputSchema extends z.ZodTypeAny | undefined = undefined,
    >(
      definition: JobDefinition<TName, TInputSchema, TOutputSchema>,
      fn: JobFunction<z.infer<TInputSchema>, TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void>
    ): JobHandle<TName, z.infer<TInputSchema>, TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void> {
      return createJobHandle(definition, fn, storage, eventEmitter, jobRegistry)
    },

    async migrate(): Promise<void> {
      // Already migrated
      if (migrated) {
        return
      }

      // Migration in progress, wait for it
      if (migrating) {
        return migrating
      }

      // Start migration
      migrating = runMigrations(db)
        .then(() => {
          migrated = true
        })
        .finally(() => {
          migrating = null
        })

      return migrating
    },
  }
}
