/**
 * Durably Server Configuration
 *
 * Sets up Durably instance with PostgreSQL and registers jobs.
 */

import { createDurably } from '@coji/durably'
import { processImageJob } from '../jobs'
import { dialect } from './database'

export const durably = createDurably({
  dialect,
  pollingIntervalMs: 1000,
  maxConcurrentRuns: 1,
  leaseRenewIntervalMs: 5000,
  leaseMs: 30000,
  retainRuns: '7d',
  jobs: {
    processImage: processImageJob,
  },
})
