/**
 * Server-connected (client mode) exports
 * Use these when connecting to a remote Durably server via HTTP/SSE
 */

export { useJob } from './use-job'
export type { UseJobClientOptions, UseJobClientResult } from './use-job'

export { useJobRun } from './use-job-run'
export type {
  UseJobRunClientOptions,
  UseJobRunClientResult,
} from './use-job-run'

export { useJobLogs } from './use-job-logs'
export type {
  UseJobLogsClientOptions,
  UseJobLogsClientResult,
} from './use-job-logs'

// Re-export types for convenience
export type { LogEntry, Progress, RunStatus } from '../types'
