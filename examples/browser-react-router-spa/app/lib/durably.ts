/**
 * Durably instance for browser-only mode
 *
 * This creates a singleton Durably instance that is shared across the app.
 */

import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { dataSyncJob, processImageJob } from './jobs'

// SQLocal instance for SQLite WASM with OPFS
export const sqlocal = new SQLocalKysely('example.sqlite3')

// Create and configure durably instance with chained register()
// register() returns a new Durably instance with type-safe jobs
const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}).register({
  processImage: processImageJob,
  dataSync: dataSyncJob,
})

await durably.migrate()

export { durably }
