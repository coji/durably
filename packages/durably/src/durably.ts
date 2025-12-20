import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import { runMigrations } from './migrations'
import type { Database } from './schema'

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

  // TODO: Add more methods in later phases
  // defineJob()
  // start()
  // stop()
  // on()
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

  // Track migration state for idempotency
  let migrating: Promise<void> | null = null
  let migrated = false

  return {
    db,

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
