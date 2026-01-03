/**
 * Server-connected (client mode) exports
 * Use these when connecting to a remote Durably server via HTTP/SSE
 */

export { createDurablyClient } from './create-durably-client'
export type {
  CreateDurablyClientOptions,
  DurablyClient,
  JobClient,
} from './create-durably-client'

export { createJobHooks } from './create-job-hooks'
export type { CreateJobHooksOptions, JobHooks } from './create-job-hooks'

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

export { useRuns } from './use-runs'
export type {
  ClientRun,
  TypedClientRun,
  UseRunsClientOptions,
  UseRunsClientResult,
} from './use-runs'

export { useRunActions } from './use-run-actions'
export type {
  RunRecord,
  StepRecord,
  UseRunActionsClientOptions,
  UseRunActionsClientResult,
} from './use-run-actions'

// Re-export types for convenience
export type { LogEntry, Progress, RunStatus } from '../types'
