/**
 * Durably instance for browser-only mode
 *
 * This creates a singleton Durably instance that is shared across the app.
 */

import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { processImageJob } from './jobs/processImage'

// Re-export job definition to ensure consistent object reference
export { processImageJob }

// SQLocal instance for SQLite WASM with OPFS
export const sqlocal = new SQLocalKysely('example.sqlite3')

async function initDurably() {
  // Create and configure durably instance with chained register()
  const instance = createDurably({
    dialect: sqlocal.dialect,
    pollingInterval: 100,
    heartbeatInterval: 500,
    staleThreshold: 3000,
  }).register({ processImage: processImageJob })

  await instance.migrate()
  return instance
}

/**
 * Shared Durably instance promise.
 * Can be passed directly to DurablyProvider.
 */
export const durably = initDurably()
