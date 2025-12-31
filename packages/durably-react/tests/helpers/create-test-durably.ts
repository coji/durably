import { createDurably, type Durably } from '@coji/durably'
import { createBrowserDialect } from './browser-dialect'

export interface TestDurablyOptions {
  pollingInterval?: number
  autoMigrate?: boolean
}

/**
 * Create a Durably instance for testing.
 * The instance is migrated unless autoMigrate is false.
 */
export async function createTestDurably(
  options?: TestDurablyOptions,
): Promise<Durably> {
  const dialect = createBrowserDialect()
  const durably = createDurably({
    dialect,
    pollingInterval: options?.pollingInterval ?? 100,
    heartbeatInterval: 500,
    staleThreshold: 3000,
  })

  if (options?.autoMigrate !== false) {
    await durably.migrate()
  }

  return durably
}
