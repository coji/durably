import type { JobDefinition } from '@coji/durably'
import { useCallback, useEffect, useState } from 'react'
import { useDurably } from '../context'
import { type TypedRun, isJobDefinition } from '../types'

// Re-export TypedRun for convenience
export type { TypedRun } from '../types'

export interface UseRunsOptions {
  /**
   * Filter by job name
   */
  jobName?: string
  /**
   * Filter by status
   */
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  /**
   * Number of runs per page
   * @default 10
   */
  pageSize?: number
  /**
   * Subscribe to real-time updates
   * @default true
   */
  realtime?: boolean
}

export interface UseRunsResult<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined =
    | Record<string, unknown>
    | undefined,
> {
  /**
   * List of runs for the current page
   */
  runs: TypedRun<TInput, TOutput>[]
  /**
   * Current page (0-indexed)
   */
  page: number
  /**
   * Whether there are more pages
   */
  hasMore: boolean
  /**
   * Whether data is being loaded
   */
  isLoading: boolean
  /**
   * Go to the next page
   */
  nextPage: () => void
  /**
   * Go to the previous page
   */
  prevPage: () => void
  /**
   * Go to a specific page
   */
  goToPage: (page: number) => void
  /**
   * Refresh the current page
   */
  refresh: () => Promise<void>
}

/**
 * Hook for listing runs with pagination and real-time updates.
 *
 * @example With generic type parameter (dashboard with multiple job types)
 * ```tsx
 * type DashboardRun = TypedRun<ImportInput, ImportOutput> | TypedRun<SyncInput, SyncOutput>
 *
 * function Dashboard() {
 *   const { runs } = useRuns<DashboardRun>({ pageSize: 10 })
 *   // runs are typed as DashboardRun[]
 * }
 * ```
 *
 * @example With JobDefinition (single job, auto-filters by jobName)
 * ```tsx
 * const myJob = defineJob({ name: 'my-job', ... })
 *
 * function Dashboard() {
 *   const { runs } = useRuns(myJob)
 *   // runs[0].output is typed!
 *   return <div>{runs[0]?.output?.someField}</div>
 * }
 * ```
 *
 * @example With options only (untyped)
 * ```tsx
 * function Dashboard() {
 *   const { runs } = useRuns({ pageSize: 20 })
 *   // runs[0].output is unknown
 * }
 * ```
 */
// Overload 1: With generic type parameter
export function useRuns<
  TRun extends TypedRun<
    Record<string, unknown>,
    Record<string, unknown> | undefined
  >,
>(
  options?: UseRunsOptions,
): UseRunsResult<
  TRun extends TypedRun<infer I, infer _O> ? I : Record<string, unknown>,
  TRun extends TypedRun<infer _I, infer O> ? O : Record<string, unknown>
>

// Overload 2: With JobDefinition for type inference (auto-filters by jobName)
export function useRuns<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined,
>(
  jobDefinition: JobDefinition<TName, TInput, TOutput>,
  options?: Omit<UseRunsOptions, 'jobName'>,
): UseRunsResult<TInput, TOutput>

// Overload 3: Without type parameter (untyped, backward compatible)
export function useRuns(options?: UseRunsOptions): UseRunsResult

// Implementation
export function useRuns<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined,
>(
  jobDefinitionOrOptions?:
    | JobDefinition<TName, TInput, TOutput>
    | UseRunsOptions,
  optionsArg?: Omit<UseRunsOptions, 'jobName'>,
): UseRunsResult<TInput, TOutput> {
  const { durably } = useDurably()

  // Determine if first argument is a JobDefinition using type guard
  const isJob = isJobDefinition(jobDefinitionOrOptions)

  const jobName = isJob
    ? jobDefinitionOrOptions.name
    : (jobDefinitionOrOptions as UseRunsOptions | undefined)?.jobName

  const options = isJob
    ? optionsArg
    : (jobDefinitionOrOptions as UseRunsOptions | undefined)

  const pageSize = options?.pageSize ?? 10
  const realtime = options?.realtime ?? true
  const status = options?.status

  const [runs, setRuns] = useState<TypedRun<TInput, TOutput>[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!durably) return

    setIsLoading(true)
    try {
      const data = await durably.getRuns({
        jobName,
        status,
        limit: pageSize + 1,
        offset: page * pageSize,
      })
      setHasMore(data.length > pageSize)
      setRuns(data.slice(0, pageSize) as TypedRun<TInput, TOutput>[])
    } finally {
      setIsLoading(false)
    }
  }, [durably, jobName, status, pageSize, page])

  // Initial fetch and subscribe to events
  useEffect(() => {
    if (!durably) return

    refresh()

    if (!realtime) return

    const unsubscribes = [
      durably.on('run:trigger', refresh),
      durably.on('run:start', refresh),
      durably.on('run:complete', refresh),
      durably.on('run:fail', refresh),
      durably.on('run:cancel', refresh),
      durably.on('run:retry', refresh),
      durably.on('run:progress', refresh),
      durably.on('step:start', refresh),
      durably.on('step:complete', refresh),
    ]

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [durably, refresh, realtime])

  const nextPage = useCallback(() => {
    if (hasMore) {
      setPage((p) => p + 1)
    }
  }, [hasMore])

  const prevPage = useCallback(() => {
    setPage((p) => Math.max(0, p - 1))
  }, [])

  const goToPage = useCallback((newPage: number) => {
    setPage(Math.max(0, newPage))
  }, [])

  return {
    runs,
    page,
    hasMore,
    isLoading,
    nextPage,
    prevPage,
    goToPage,
    refresh,
  }
}
