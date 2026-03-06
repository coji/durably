import type { InferInput, InferOutput } from '../types'
import { createJobHooks, type JobHooks } from './create-job-hooks'
import {
  useRunActions,
  type UseRunActionsClientResult,
} from './use-run-actions'
import {
  useRuns,
  type UseRunsClientOptions,
  type UseRunsClientResult,
} from './use-runs'

/**
 * Options for createDurably
 */
export interface CreateDurablyOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
}

/**
 * Extract the jobs record from a Durably instance type.
 * Allows `createDurably<typeof serverDurably>()` to infer job types.
 */
type ExtractJobs<T> = T extends { readonly jobs: infer TJobs } ? TJobs : T

/**
 * A type-safe Durably client with per-job hooks and cross-job utilities.
 */
export type DurablyClient<T> = {
  [K in keyof ExtractJobs<T>]: JobHooks<
    InferInput<ExtractJobs<T>[K]>,
    InferOutput<ExtractJobs<T>[K]>
  >
} & {
  /**
   * List runs with pagination and real-time updates (cross-job).
   * The `api` option is pre-configured.
   */
  useRuns: <
    TInput extends Record<string, unknown> = Record<string, unknown>,
    TOutput extends Record<string, unknown> | undefined =
      | Record<string, unknown>
      | undefined,
  >(
    options?: Omit<UseRunsClientOptions, 'api'>,
  ) => UseRunsClientResult<TInput, TOutput>

  /**
   * Run actions: retry, cancel, delete, getRun, getSteps (cross-job).
   * The `api` option is pre-configured.
   */
  useRunActions: () => UseRunActionsClientResult
}

/**
 * Create a type-safe Durably client for React.
 *
 * Uses the same name as the server-side `createDurably` — the API endpoint
 * option distinguishes it from the server constructor.
 *
 * @example
 * ```tsx
 * // Server: create Durably instance
 * // app/lib/durably.server.ts
 * import { createDurably } from '@coji/durably'
 * export const durably = createDurably({
 *   dialect,
 *   jobs: { importCsv: importCsvJob, syncUsers: syncUsersJob },
 * })
 *
 * // Client: create typed hooks
 * // app/lib/durably.ts
 * import type { durably as serverDurably } from '~/lib/durably.server'
 * import { createDurably } from '@coji/durably-react'
 *
 * export const durably = createDurably<typeof serverDurably>({
 *   api: '/api/durably',
 * })
 *
 * // In your component — fully type-safe with autocomplete
 * function CsvImporter() {
 *   const { trigger, output, isRunning } = durably.importCsv.useJob()
 *   return <button onClick={() => trigger({ rows: [...] })}>Import</button>
 * }
 *
 * // Cross-job hooks
 * function Dashboard() {
 *   const { runs, nextPage } = durably.useRuns({ pageSize: 10 })
 *   const { retry, cancel } = durably.useRunActions()
 * }
 * ```
 */
export function createDurably<T>(
  options: CreateDurablyOptions,
): DurablyClient<T> {
  const { api } = options
  const cache = new Map<string, unknown>()

  // Built-in cross-job hooks. These names are reserved and cannot be used as job names.
  // If a job is registered with one of these names, the built-in hook takes precedence.
  const builtins: Record<string, unknown> = {
    useRuns: (opts?: Omit<UseRunsClientOptions, 'api'>) =>
      useRuns({ api, ...opts }),
    useRunActions: () => useRunActions({ api }),
  }

  // Create a proxy that generates and caches job hooks on demand
  return new Proxy({} as DurablyClient<T>, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined

      // Return built-in hooks first
      if (key in builtins) return builtins[key]

      // Return cached or create new job hooks
      let hooks = cache.get(key)
      if (!hooks) {
        hooks = createJobHooks({ api, jobName: key })
        cache.set(key, hooks)
      }
      return hooks
    },
  })
}
