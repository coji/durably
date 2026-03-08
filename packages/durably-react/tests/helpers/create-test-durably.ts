import { createDurably, type Durably } from '@coji/durably'
import { createBrowserDialect } from './browser-dialect'

export interface TestDurablyOptions {
  pollingIntervalMs?: number
  autoMigrate?: boolean
  /**
   * Whether to start the worker. When false, only migrate() is called.
   * @default true
   */
  autoStart?: boolean
}

/**
 * Create a Durably instance for testing.
 * The instance is initialized (migrate + start) unless autoMigrate is false.
 */
export async function createTestDurably(
  options?: TestDurablyOptions,
): Promise<Durably> {
  const dialect = createBrowserDialect()
  const durably = createDurably({
    dialect,
    pollingIntervalMs: options?.pollingIntervalMs ?? 100,
    leaseRenewIntervalMs: 500,
    leaseMs: 3000,
  })

  if (options?.autoMigrate !== false) {
    if (options?.autoStart === false) {
      // Only migrate, don't start the worker
      await durably.migrate()
    } else {
      // Default: init() = migrate() + start()
      await durably.init()
    }
  }

  return durably
}
