import type { JobDefinition } from '@coji/durably'
import { useJob, type UseJobClientResult } from './use-job'
import { useJobLogs, type UseJobLogsClientResult } from './use-job-logs'
import { useJobRun, type UseJobRunClientResult } from './use-job-run'

/**
 * Extract input type from a JobDefinition or JobHandle
 */
type InferInput<T> =
  T extends JobDefinition<string, infer TInput, unknown>
    ? TInput extends Record<string, unknown>
      ? TInput
      : Record<string, unknown>
    : T extends { trigger: (input: infer TInput) => unknown }
      ? TInput extends Record<string, unknown>
        ? TInput
        : Record<string, unknown>
      : Record<string, unknown>

/**
 * Extract output type from a JobDefinition or JobHandle
 */
type InferOutput<T> =
  T extends JobDefinition<string, unknown, infer TOutput>
    ? TOutput extends Record<string, unknown>
      ? TOutput
      : Record<string, unknown>
    : T extends {
          trigger: (input: unknown) => Promise<{ output?: infer TOutput }>
        }
      ? TOutput extends Record<string, unknown>
        ? TOutput
        : Record<string, unknown>
      : Record<string, unknown>

/**
 * Type-safe hooks for a specific job
 */
export interface JobClient<TInput, TOutput> {
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
 * Options for createDurablyClient
 */
export interface CreateDurablyClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
}

/**
 * A type-safe client with hooks for each registered job
 */
export type DurablyClient<TJobs extends Record<string, unknown>> = {
  [K in keyof TJobs]: JobClient<InferInput<TJobs[K]>, InferOutput<TJobs[K]>>
}

/**
 * Create a type-safe Durably client with hooks for all registered jobs.
 *
 * @example
 * ```tsx
 * // Server: register jobs
 * // app/lib/durably.server.ts
 * export const jobs = durably.register({
 *   importCsv: importCsvJob,
 *   syncUsers: syncUsersJob,
 * })
 *
 * // Client: create typed client
 * // app/lib/durably.client.ts
 * import type { jobs } from '~/lib/durably.server'
 * import { createDurablyClient } from '@coji/durably-react/client'
 *
 * export const durably = createDurablyClient<typeof jobs>({
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
export function createDurablyClient<TJobs extends Record<string, unknown>>(
  options: CreateDurablyClientOptions,
): DurablyClient<TJobs> {
  const { api } = options

  // Create a proxy that generates job clients on demand
  return new Proxy({} as DurablyClient<TJobs>, {
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
