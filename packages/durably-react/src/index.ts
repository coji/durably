// @coji/durably-react - Fullstack mode (default)
// Connect to a Durably server via HTTP/SSE
//
// For SPA/offline mode (browser-only with OPFS), use:
//   @coji/durably-react/spa

// Type-safe hooks factory
export { createDurablyHooks } from './client/create-durably-hooks'
export type {
  CreateDurablyHooksOptions,
  DurablyHooks,
  JobHooks,
} from './client/create-durably-hooks'

export { createJobHooks } from './client/create-job-hooks'
export type {
  CreateJobHooksOptions,
  JobHooks as SingleJobHooks,
} from './client/create-job-hooks'

// Direct hooks
export { useJob } from './client/use-job'
export type { UseJobClientOptions, UseJobClientResult } from './client/use-job'

export { useJobRun } from './client/use-job-run'
export type {
  UseJobRunClientOptions,
  UseJobRunClientResult,
} from './client/use-job-run'

export { useJobLogs } from './client/use-job-logs'
export type {
  UseJobLogsClientOptions,
  UseJobLogsClientResult,
} from './client/use-job-logs'

export { useRuns } from './client/use-runs'
export type {
  ClientRun,
  TypedClientRun,
  UseRunsClientOptions,
  UseRunsClientResult,
} from './client/use-runs'

export { useRunActions } from './client/use-run-actions'
export type {
  StepRecord,
  UseRunActionsClientOptions,
  UseRunActionsClientResult,
} from './client/use-run-actions'

// Shared types
export type { DurablyEvent, LogEntry, Progress, RunStatus } from './types'
