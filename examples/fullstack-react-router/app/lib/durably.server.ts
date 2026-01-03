/**
 * Durably Server Configuration
 *
 * Sets up Durably instance, registers jobs, and provides HTTP handler.
 * Server-only - do not import in client code.
 *
 * Note: In development with HMR, this module may reload on changes.
 * For production apps, consider using a singleton pattern to prevent
 * multiple instances.
 */

import { createDurably, createDurablyHandler } from '@coji/durably'
import { dataSyncJob, importCsvJob, processImageJob } from '~/jobs'
import { dialect } from './database.server'

// Create Durably instance with registered jobs
export const durably = createDurably({
  dialect,
}).register({
  processImage: processImageJob,
  dataSync: dataSyncJob,
  importCsv: importCsvJob,
})

// HTTP handler for SSE streaming
export const durablyHandler = createDurablyHandler(durably)

// Initialize database and start worker
await durably.init()
