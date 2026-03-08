/**
 * Durably instance for browser-only mode
 *
 * This creates a singleton Durably instance that is shared across the app.
 */

import { createDurably } from '@coji/durably'
import { dataSyncJob, processImageJob } from '../jobs'
import { sqlocal } from './database'

// Create durably instance with jobs
const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingIntervalMs: 100,
  leaseRenewIntervalMs: 500,
  leaseMs: 3000,
  jobs: {
    processImage: processImageJob,
    dataSync: dataSyncJob,
  },
})

await durably.init()

export { durably }
