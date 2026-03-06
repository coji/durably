import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import type { z } from 'zod'
import type { JobDefinition } from './define-job'
import {
  type AnyEventInput,
  type DurablyEvent,
  type ErrorHandler,
  type EventEmitter,
  type EventListener,
  type EventType,
  type Unsubscribe,
  createEventEmitter,
} from './events'
import {
  type JobHandle,
  type JobRegistry,
  createJobHandle,
  createJobRegistry,
} from './job'
import { runMigrations } from './migrations'
import type { Database } from './schema'
import {
  type Run,
  type RunFilter,
  type Storage,
  createKyselyStorage,
} from './storage'
import { type Worker, createWorker } from './worker'

/**
 * Options for creating a Durably instance
 */
export interface DurablyOptions<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
> {
  dialect: Dialect
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
  /**
   * Zod schema for labels. When provided:
   * - Labels are type-checked at compile time
   * - Labels are validated at runtime on trigger()
   */
  labels?: z.ZodType<TLabels>
  /**
   * Job definitions to register. Shorthand for calling .register() after creation.
   * @example
   * ```ts
   * const durably = createDurably({
   *   dialect,
   *   jobs: { importCsv: importCsvJob, syncUsers: syncUsersJob },
   * })
   * ```
   */
  jobs?: TJobs
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
 * Plugin interface for extending Durably
 */
export interface DurablyPlugin {
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: plugin needs to accept any Durably instance
  install(durably: Durably<any, any>): void
}

/**
 * Helper type to transform JobDefinition record to JobHandle record
 */
type TransformToHandles<
  TJobs extends Record<string, JobDefinition<string, unknown, unknown>>,
  TLabels extends Record<string, string> = Record<string, string>,
> = {
  [K in keyof TJobs]: TJobs[K] extends JobDefinition<
    infer TName,
    infer TInput,
    infer TOutput
  >
    ? JobHandle<TName & string, TInput, TOutput, TLabels>
    : never
}

/**
 * Durably instance with type-safe jobs
 */
export interface Durably<
  TJobs extends Record<
    string,
    JobHandle<string, unknown, unknown, Record<string, string>>
  > = Record<string, never>,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /**
   * Registered job handles (type-safe)
   */
  readonly jobs: TJobs

  /**
   * Initialize Durably: run migrations and start the worker
   * This is the recommended way to start Durably.
   * Equivalent to calling migrate() then start().
   * @example
   * ```ts
   * const durably = createDurably({ dialect }).register({ ... })
   * await durably.init()
   * ```
   */
  init(): Promise<void>

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
   * Register an error handler for listener exceptions
   */
  onError(handler: ErrorHandler): void

  /**
   * Register job definitions and return a new Durably instance with type-safe jobs
   * @example
   * ```ts
   * const durably = createDurably({ dialect })
   *   .register({
   *     importCsv: importCsvJob,
   *     syncUsers: syncUsersJob,
   *   })
   * await durably.migrate()
   * // Usage: durably.jobs.importCsv.trigger({ rows: [...] })
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  register<TNewJobs extends Record<string, JobDefinition<string, any, any>>>(
    jobDefs: TNewJobs,
  ): Durably<TJobs & TransformToHandles<TNewJobs, TLabels>, TLabels>

  /**
   * Start the worker polling loop
   */
  start(): void

  /**
   * Stop the worker after current run completes
   */
  stop(): Promise<void>

  /**
   * Retry a failed run by resetting it to pending
   * @throws Error if run is not in failed status
   */
  retry(runId: string): Promise<void>

  /**
   * Cancel a pending or running run
   * @throws Error if run is already completed, failed, or cancelled
   */
  cancel(runId: string): Promise<void>

  /**
   * Delete a completed, failed, or cancelled run and its associated steps and logs
   * @throws Error if run is pending or running, or does not exist
   */
  deleteRun(runId: string): Promise<void>

  /**
   * Get a run by ID
   * @example
   * ```ts
   * // Untyped (returns Run)
   * const run = await durably.getRun(runId)
   *
   * // Typed (returns custom type)
   * type MyRun = Run & { input: { userId: string }; output: { count: number } | null }
   * const typedRun = await durably.getRun<MyRun>(runId)
   * ```
   */
  getRun<T extends Run<TLabels> = Run<TLabels>>(
    runId: string,
  ): Promise<T | null>

  /**
   * Get runs with optional filtering
   * @example
   * ```ts
   * // Untyped (returns Run[])
   * const runs = await durably.getRuns({ status: 'completed' })
   *
   * // Typed (returns custom type[])
   * type MyRun = Run & { input: { userId: string }; output: { count: number } | null }
   * const typedRuns = await durably.getRuns<MyRun>({ jobName: 'my-job' })
   * ```
   */
  getRuns<T extends Run<TLabels> = Run<TLabels>>(
    filter?: RunFilter<TLabels>,
  ): Promise<T[]>

  /**
   * Register a plugin
   */
  use(plugin: DurablyPlugin): void

  /**
   * Get a registered job handle by name
   * Returns undefined if job is not registered
   */
  getJob<TName extends string = string>(
    name: TName,
  ): JobHandle<TName, Record<string, unknown>, unknown, TLabels> | undefined

  /**
   * Subscribe to events for a specific run
   * Returns a ReadableStream that can be used for SSE
   */
  subscribe(runId: string): ReadableStream<DurablyEvent>
}

/**
 * Internal state shared across Durably instances
 */
interface DurablyState {
  db: Kysely<Database>
  storage: Storage
  eventEmitter: EventEmitter
  jobRegistry: JobRegistry
  worker: Worker
  labelsSchema: z.ZodType | undefined
  migrating: Promise<void> | null
  migrated: boolean
}

/**
 * Create a Durably instance implementation
 */
function createDurablyInstance<
  TJobs extends Record<
    string,
    JobHandle<string, unknown, unknown, Record<string, string>>
  >,
  TLabels extends Record<string, string> = Record<string, string>,
>(state: DurablyState, jobs: TJobs): Durably<TJobs, TLabels> {
  const { db, storage, eventEmitter, jobRegistry, worker } = state

  const durably: Durably<TJobs, TLabels> = {
    db,
    storage,
    jobs,
    on: eventEmitter.on,
    emit: eventEmitter.emit,
    onError: eventEmitter.onError,
    start: worker.start,
    stop: worker.stop,

    // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
    register<TNewJobs extends Record<string, JobDefinition<string, any, any>>>(
      jobDefs: TNewJobs,
    ): Durably<TJobs & TransformToHandles<TNewJobs, TLabels>, TLabels> {
      const newHandles = {} as TransformToHandles<TNewJobs, TLabels>

      for (const key of Object.keys(jobDefs) as (keyof TNewJobs)[]) {
        const jobDef = jobDefs[key]
        const handle = createJobHandle(
          jobDef,
          storage,
          eventEmitter,
          jobRegistry,
          state.labelsSchema as z.ZodType<TLabels> | undefined,
        )
        newHandles[key] = handle as TransformToHandles<
          TNewJobs,
          TLabels
        >[typeof key]
      }

      // Create new instance with merged jobs
      const mergedJobs = { ...jobs, ...newHandles } as TJobs &
        TransformToHandles<TNewJobs, TLabels>
      return createDurablyInstance<typeof mergedJobs, TLabels>(
        state,
        mergedJobs,
      )
    },

    getRun: storage.getRun,
    getRuns: storage.getRuns,

    use(plugin: DurablyPlugin): void {
      plugin.install(durably)
    },

    getJob<TName extends string = string>(
      name: TName,
    ): JobHandle<TName, Record<string, unknown>, unknown, TLabels> | undefined {
      const registeredJob = jobRegistry.get(name)
      if (!registeredJob) {
        return undefined
      }
      return registeredJob.handle as JobHandle<
        TName,
        Record<string, unknown>,
        unknown,
        TLabels
      >
    },

    subscribe(runId: string): ReadableStream<DurablyEvent> {
      // Track closed state and cleanup function in outer scope for cancel handler
      let closed = false
      let cleanup: (() => void) | null = null

      return new ReadableStream<DurablyEvent>({
        start: (controller) => {
          const unsubscribeStart = eventEmitter.on('run:start', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
            }
          })

          const unsubscribeComplete = eventEmitter.on(
            'run:complete',
            (event) => {
              if (!closed && event.runId === runId) {
                controller.enqueue(event)
                closed = true
                cleanup?.()
                controller.close()
              }
            },
          )

          const unsubscribeFail = eventEmitter.on('run:fail', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
              // Don't close stream on fail - retry is possible
            }
          })

          const unsubscribeCancel = eventEmitter.on('run:cancel', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
              // Don't close stream on cancel - retry is possible
            }
          })

          const unsubscribeDelete = eventEmitter.on('run:delete', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
              closed = true
              cleanup?.()
              controller.close()
            }
          })

          const unsubscribeRetry = eventEmitter.on('run:retry', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
            }
          })

          const unsubscribeProgress = eventEmitter.on(
            'run:progress',
            (event) => {
              if (!closed && event.runId === runId) {
                controller.enqueue(event)
              }
            },
          )

          const unsubscribeStepStart = eventEmitter.on(
            'step:start',
            (event) => {
              if (!closed && event.runId === runId) {
                controller.enqueue(event)
              }
            },
          )

          const unsubscribeStepComplete = eventEmitter.on(
            'step:complete',
            (event) => {
              if (!closed && event.runId === runId) {
                controller.enqueue(event)
              }
            },
          )

          const unsubscribeStepFail = eventEmitter.on('step:fail', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
            }
          })

          const unsubscribeLog = eventEmitter.on('log:write', (event) => {
            if (!closed && event.runId === runId) {
              controller.enqueue(event)
            }
          })

          // Assign cleanup function to outer scope for cancel handler
          cleanup = () => {
            unsubscribeStart()
            unsubscribeComplete()
            unsubscribeFail()
            unsubscribeCancel()
            unsubscribeDelete()
            unsubscribeRetry()
            unsubscribeProgress()
            unsubscribeStepStart()
            unsubscribeStepComplete()
            unsubscribeStepFail()
            unsubscribeLog()
          }
        },
        cancel: () => {
          // Clean up event listeners when stream is cancelled by consumer
          if (!closed) {
            closed = true
            cleanup?.()
          }
        },
      })
    },

    async retry(runId: string): Promise<void> {
      const run = await storage.getRun(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (run.status === 'completed') {
        throw new Error(`Cannot retry completed run: ${runId}`)
      }
      if (run.status === 'pending') {
        throw new Error(`Cannot retry pending run: ${runId}`)
      }
      if (run.status === 'running') {
        throw new Error(`Cannot retry running run: ${runId}`)
      }
      await storage.updateRun(runId, {
        status: 'pending',
        error: null,
      })

      // Emit run:retry event
      eventEmitter.emit({
        type: 'run:retry',
        runId,
        jobName: run.jobName,
        labels: run.labels,
      })
    },

    async cancel(runId: string): Promise<void> {
      const run = await storage.getRun(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (run.status === 'completed') {
        throw new Error(`Cannot cancel completed run: ${runId}`)
      }
      if (run.status === 'failed') {
        throw new Error(`Cannot cancel failed run: ${runId}`)
      }
      if (run.status === 'cancelled') {
        throw new Error(`Cannot cancel already cancelled run: ${runId}`)
      }
      await storage.updateRun(runId, {
        status: 'cancelled',
      })

      // Emit run:cancel event
      eventEmitter.emit({
        type: 'run:cancel',
        runId,
        jobName: run.jobName,
        labels: run.labels,
      })
    },

    async deleteRun(runId: string): Promise<void> {
      const run = await storage.getRun(runId)
      if (!run) {
        throw new Error(`Run not found: ${runId}`)
      }
      if (run.status === 'pending') {
        throw new Error(`Cannot delete pending run: ${runId}`)
      }
      if (run.status === 'running') {
        throw new Error(`Cannot delete running run: ${runId}`)
      }
      await storage.deleteRun(runId)

      // Emit run:delete event
      eventEmitter.emit({
        type: 'run:delete',
        runId,
        jobName: run.jobName,
        labels: run.labels,
      })
    },

    async migrate(): Promise<void> {
      if (state.migrated) {
        return
      }

      if (state.migrating) {
        return state.migrating
      }

      state.migrating = runMigrations(db)
        .then(() => {
          state.migrated = true
        })
        .finally(() => {
          state.migrating = null
        })

      return state.migrating
    },

    async init(): Promise<void> {
      await this.migrate()
      this.start()
    },
  }

  return durably
}

/**
 * Create a Durably instance
 */
// Overload: with jobs
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
>(
  options: DurablyOptions<TLabels, TJobs> & { jobs: TJobs },
): Durably<TransformToHandles<TJobs, TLabels>, TLabels>

// Overload: without jobs
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
>(options: DurablyOptions<TLabels>): Durably<Record<string, never>, TLabels>

// Implementation
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
>(
  options: DurablyOptions<TLabels, TJobs>,
):
  | Durably<TransformToHandles<TJobs, TLabels>, TLabels>
  | Durably<Record<string, never>, TLabels> {
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

  const state: DurablyState = {
    db,
    storage,
    eventEmitter,
    jobRegistry,
    worker,
    labelsSchema: options.labels,
    migrating: null,
    migrated: false,
  }

  const instance = createDurablyInstance<Record<string, never>, TLabels>(
    state,
    {},
  )

  if (options.jobs) {
    return instance.register(options.jobs)
  }

  return instance
}
