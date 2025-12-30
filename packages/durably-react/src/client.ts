// @coji/durably-react/client - Server-connected mode
// This entry point is for connecting to a remote Durably server via HTTP/SSE

// Type-safe client factories (recommended)
export { createDurablyClient } from './client/create-durably-client'
export type {
  CreateDurablyClientOptions,
  DurablyClient,
  JobClient,
} from './client/create-durably-client'

export { createJobHooks } from './client/create-job-hooks'
export type { CreateJobHooksOptions, JobHooks } from './client/create-job-hooks'

// Low-level hooks (for advanced use cases)
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

// Re-export shared types
export type { LogEntry, Progress, RunStatus } from './types'
