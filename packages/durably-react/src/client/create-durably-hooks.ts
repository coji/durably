import type { InferInput, InferOutput } from '../types'
import { useJob, type UseJobClientResult } from './use-job'
import { useJobLogs, type UseJobLogsClientResult } from './use-job-logs'
import { useJobRun, type UseJobRunClientResult } from './use-job-run'

/**
 * Type-safe hooks for a specific job
 */
export interface JobHooks<TInput, TOutput> {
  /**
   * Hook for triggering and monitoring the job
   */
  useJob: () => UseJobClientResult<TInput, TOutput>

  /**
   * Hook for subscribing to an existing run by ID
   */
  useRun: (runId: string | null) => UseJobRunClientResult<TOutput>

  /**
   * Hook for subscribing to logs from a run
   */
  useLogs: (
    runId: string | null,
    options?: { maxLogs?: number },
  ) => UseJobLogsClientResult
}

/**
 * Options for createDurablyHooks
 */
export interface CreateDurablyHooksOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
}

/**
 * A type-safe hooks collection for each registered job
 */
export type DurablyHooks<TJobs extends Record<string, unknown>> = {
  [K in keyof TJobs]: JobHooks<InferInput<TJobs[K]>, InferOutput<TJobs[K]>>
}

/**
 * Create type-safe hooks for all registered jobs.
 *
 * @example
 * ```tsx
 * // Server: register jobs
 * // app/lib/durably.server.ts
 * export const durably = createDurably({
 *   dialect,
 *   jobs: { importCsv: importCsvJob, syncUsers: syncUsersJob },
 * })
 *
 * // Client: create typed hooks
 * // app/lib/durably.hooks.ts
 * import type { durably } from '~/lib/durably.server'
 * import { createDurablyHooks } from '@coji/durably-react/fullstack'
 *
 * export const durably = createDurablyHooks<typeof durably>({
 *   api: '/api/durably',
 * })
 *
 * // In your component - fully type-safe with autocomplete
 * function CsvImporter() {
 *   const { trigger, output, isRunning } = durably.importCsv.useJob()
 *
 *   return (
 *     <button onClick={() => trigger({ rows: [...] })}>
 *       Import
 *     </button>
 *   )
 * }
 * ```
 */
export function createDurablyHooks<TJobs extends Record<string, unknown>>(
  options: CreateDurablyHooksOptions,
): DurablyHooks<TJobs> {
  const { api } = options

  // Create a proxy that generates job hooks on demand
  return new Proxy({} as DurablyHooks<TJobs>, {
    get(_target, jobKey: string) {
      return {
        useJob: () => {
          return useJob({ api, jobName: jobKey })
        },

        useRun: (runId: string | null) => {
          return useJobRun({ api, runId })
        },

        useLogs: (runId: string | null, logsOptions?: { maxLogs?: number }) => {
          return useJobLogs({ api, runId, maxLogs: logsOptions?.maxLogs })
        },
      }
    },
  })
}

// Backward compatibility re-exports
/** @deprecated Use `createDurablyHooks` instead */
export const createDurablyClient = createDurablyHooks
/** @deprecated Use `CreateDurablyHooksOptions` instead */
export type CreateDurablyClientOptions = CreateDurablyHooksOptions
/** @deprecated Use `DurablyHooks` instead */
export type DurablyClient<TJobs extends Record<string, unknown>> =
  DurablyHooks<TJobs>
/** @deprecated Use `JobHooks` instead */
export type JobClient<TInput, TOutput> = JobHooks<TInput, TOutput>
