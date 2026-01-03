/**
 * Job Definitions
 *
 * Barrel export for all job definitions.
 * When adding a new job, import and add it here.
 */

import type { JobInput, JobOutput } from '@coji/durably'
import { dataSyncJob } from './data-sync'
import { processImageJob } from './process-image'

export { dataSyncJob, processImageJob }

/** Input/Output types for all jobs - used for typed useRuns dashboard */
export type DataSyncInput = JobInput<typeof dataSyncJob>
export type DataSyncOutput = JobOutput<typeof dataSyncJob>
export type ProcessImageInput = JobInput<typeof processImageJob>
export type ProcessImageOutput = JobOutput<typeof processImageJob>
