import type { JobDefinition } from '@coji/durably'
import type { InferInput, InferOutput } from '../types'
import {
  useJob,
  type UseJobClientOptions,
  type UseJobClientResult,
} from './use-job'
import {
  useJobLogs,
  type UseJobLogsClientOptions,
  type UseJobLogsClientResult,
} from './use-job-logs'
import {
  useJobRun,
  type UseJobRunClientOptions,
  type UseJobRunClientResult,
} from './use-job-run'

/**
 * Options for createJobHooks
 */
export interface CreateJobHooksOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
  /**
   * Job name (must match the server-side job name)
   */
  jobName: string
}

/**
 * Type-safe hooks for a specific job
 */
export interface JobHooks<TInput, TOutput> {
  /**
   * Hook for triggering and monitoring the job
   */
  useJob: (
    options?: Omit<UseJobClientOptions, 'api' | 'jobName'>,
  ) => UseJobClientResult<TInput, TOutput>

  /**
   * Hook for subscribing to an existing run by ID
   */
  useRun: (
    runId: string | null,
    options?: Omit<UseJobRunClientOptions, 'api' | 'runId'>,
  ) => UseJobRunClientResult<TOutput>

  /**
   * Hook for subscribing to logs from a run
   */
  useLogs: (
    runId: string | null,
    options?: Omit<UseJobLogsClientOptions, 'api' | 'runId'>,
  ) => UseJobLogsClientResult
}

/**
 * Create type-safe hooks for a specific job.
 *
 * @example
 * ```tsx
 * // Import job type from server (type-only import is safe)
 * import type { importCsvJob } from '~/lib/durably.server'
 * import { createJobHooks } from '@coji/durably-react'
 *
 * const importCsv = createJobHooks<typeof importCsvJob>({
 *   api: '/api/durably',
 *   jobName: 'import-csv',
 * })
 *
 * // In your component - fully type-safe
 * function CsvImporter() {
 *   const { trigger, output, progress, isLeased } = importCsv.useJob()
 *
 *   return (
 *     <button onClick={() => trigger({ rows: [...] })}>
 *       Import
 *     </button>
 *   )
 * }
 * ```
 */
export function createJobHooks<
  // biome-ignore lint/suspicious/noExplicitAny: TJob needs to accept any JobDefinition
  TJob extends JobDefinition<string, any, any>,
>(
  options: CreateJobHooksOptions,
): JobHooks<InferInput<TJob>, InferOutput<TJob>> {
  const { api, jobName } = options

  return {
    useJob: (jobOptions) => {
      return useJob<InferInput<TJob>, InferOutput<TJob>>({
        api,
        jobName,
        ...jobOptions,
      })
    },

    useRun: (runId, runOptions) => {
      return useJobRun<InferOutput<TJob>>({ api, runId, ...runOptions })
    },

    useLogs: (runId, logsOptions) => {
      return useJobLogs({ api, runId, ...logsOptions })
    },
  }
}
