import type { InferInput, InferOutput } from '../types'
import { createJobHooks, type JobHooks } from './create-job-hooks'

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
 * import { createDurablyHooks } from '@coji/durably-react'
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
  const cache = new Map<string, JobHooks<unknown, unknown>>()

  // Create a proxy that generates and caches job hooks on demand
  return new Proxy({} as DurablyHooks<TJobs>, {
    get(_target, jobKey) {
      if (typeof jobKey !== 'string') return undefined
      let hooks = cache.get(jobKey)
      if (!hooks) {
        hooks = createJobHooks({ api, jobName: jobKey })
        cache.set(jobKey, hooks)
      }
      return hooks
    },
  })
}
