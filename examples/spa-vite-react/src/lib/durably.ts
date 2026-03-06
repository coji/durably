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
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
  jobs: {
    processImage: processImageJob,
    dataSync: dataSyncJob,
  },
})

await durably.init()

export { durably }
