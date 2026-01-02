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

// Create and configure durably instance
const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})

await durably.migrate()

// Register jobs - populates durably.jobs
durably.register({
  processImage: processImageJob,
  dataSync: dataSyncJob,
})

export { durably }
