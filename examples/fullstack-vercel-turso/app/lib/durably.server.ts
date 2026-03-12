/**
 * Durably Server Configuration (Vercel Serverless)
 *
 * Sets up Durably instance, registers jobs, and provides HTTP handler.
 * Server-only - do not import in client code.
 *
 * Key difference from Fly.io: no top-level `await durably.init()`.
 * Instead, `onRequest` lazily initializes on each request.
 * This works because Vercel functions are short-lived — the worker
 * runs during the lifetime of the request (including SSE streaming).
 */

import { createDurably, createDurablyHandler } from '@coji/durably'
import {
  dataSyncJob,
  generateReportJob,
  importCsvJob,
  processImageJob,
} from '~/jobs'
import { dialect } from './database.server'

// Create Durably instance with jobs
export const durably = createDurably({
  dialect,
  preserveSteps: true,
  jobs: {
    processImage: processImageJob,
    dataSync: dataSyncJob,
    importCsv: importCsvJob,
    generateReport: generateReportJob,
  },
})

// HTTP handler with lazy initialization.
// init() is safe to call multiple times — it migrates the DB and starts
// the worker on first call, subsequent calls are no-ops.
// The worker stays alive as long as the request is active (e.g., SSE streaming).
export const durablyHandler = createDurablyHandler(durably, {
  onRequest: async () => {
    await durably.init()
  },
})
