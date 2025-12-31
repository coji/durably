/**
 * Durably instance for browser-only mode
 *
 * This creates a singleton Durably instance that is shared across the app.
 */

import { createDurably, type Durably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { processImageJob } from './jobs/processImage'

// Re-export job definition to ensure consistent object reference
export { processImageJob }

// SQLocal instance for SQLite WASM with OPFS
export const sqlocal = new SQLocalKysely('example.sqlite3')

// Singleton Durably instance (lazily initialized)
let durablyInstance: Durably | null = null
let durablyPromise: Promise<Durably> | null = null

/**
 * Get the shared Durably instance.
 * Creates and migrates on first call, returns cached instance thereafter.
 */
export async function getDurably(): Promise<Durably> {
  if (durablyInstance) {
    return durablyInstance
  }

  if (!durablyPromise) {
    durablyPromise = (async () => {
      const instance = createDurably({
        dialect: sqlocal.dialect,
        pollingInterval: 100,
        heartbeatInterval: 500,
        staleThreshold: 3000,
      })
      await instance.migrate()

      // Pre-register jobs immediately after migration
      instance.register({ processImage: processImageJob })

      durablyInstance = instance
      return instance
    })()
  }

  return durablyPromise
}
