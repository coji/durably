/**
 * Durably Server Configuration
 *
 * Sets up Durably instance and registers jobs.
 */

import { createDurably } from '@coji/durably'
import { processImageJob } from '../jobs'
import { dialect } from './database'

// Create durably instance with jobs
export const durably = createDurably({
  dialect,
  pollingIntervalMs: 100,
  leaseRenewIntervalMs: 500,
  leaseMs: 3000,
  jobs: {
    processImage: processImageJob,
  },
})
