/**
 * Durably Server Configuration
 *
 * Sets up Durably instance and registers jobs.
 */

import { createDurably } from '@coji/durably'
import { processImageJob } from '../jobs'
import { dialect } from './database'

// Create and configure durably instance with chained register()
// register() returns a new Durably instance with type-safe jobs
export const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}).register({
  processImage: processImageJob,
})
