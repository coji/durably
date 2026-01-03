import type { JobDefinition } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type Progress,
  type RunStatus,
  type TypedClientRun,
  isJobDefinition,
} from '../types'

// Re-export types for convenience
export type { ClientRun, TypedClientRun } from '../types'

/**
 * SSE notification event from /runs/subscribe
 */
type RunUpdateEvent =
  | {
      type:
        | 'run:trigger'
        | 'run:start'
        | 'run:complete'
        | 'run:fail'
        | 'run:cancel'
        | 'run:retry'
      runId: string
      jobName: string
    }
  | { type: 'run:progress'; runId: string; jobName: string; progress: Progress }
  | {
      type: 'step:start' | 'step:complete'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
    }
  | {
      type: 'step:fail'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
      error: string
    }
  | {
      type: 'log:write'
      runId: string
      stepName: string | null
      level: 'info' | 'warn' | 'error'
      message: string
      data: unknown
    }

export interface UseRunsClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
  /**
   * Filter by job name
   */
  jobName?: string
  /**
   * Filter by status
   */
  status?: RunStatus
  /**
   * Number of runs per page
   * @default 10
   */
  pageSize?: number
}

export interface UseRunsClientResult<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined =
    | Record<string, unknown>
    | undefined,
> {
  /**
   * List of runs for the current page
   */
  runs: TypedClientRun<TInput, TOutput>[]
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
   * Error message if fetch failed
   */
  error: string | null
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
 * Hook for listing runs via server API with pagination.
 * First page (page 0) automatically subscribes to SSE for real-time updates.
 * Other pages are static and require manual refresh.
 *
 * @example With generic type parameter (dashboard with multiple job types)
 * ```tsx
 * type DashboardRun = TypedClientRun<ImportInput, ImportOutput> | TypedClientRun<SyncInput, SyncOutput>
 *
 * function Dashboard() {
 *   const { runs } = useRuns<DashboardRun>({ api: '/api/durably', pageSize: 10 })
 *   // runs are typed as DashboardRun[]
 * }
 * ```
 *
 * @example With JobDefinition (single job, auto-filters by jobName)
 * ```tsx
 * const myJob = defineJob({ name: 'my-job', ... })
 *
 * function RunHistory() {
 *   const { runs } = useRuns(myJob, { api: '/api/durably' })
 *   // runs[0].output is typed!
 *   return <div>{runs[0]?.output?.someField}</div>
 * }
 * ```
 *
 * @example With options only (untyped)
 * ```tsx
 * function RunHistory() {
 *   const { runs } = useRuns({ api: '/api/durably', pageSize: 10 })
 *   // runs[0].output is unknown
 * }
 * ```
 */
// Overload 1: With generic type parameter
export function useRuns<
  TRun extends TypedClientRun<
    Record<string, unknown>,
    Record<string, unknown> | undefined
  >,
>(
  options: UseRunsClientOptions,
): UseRunsClientResult<
  TRun extends TypedClientRun<infer I, infer _O> ? I : Record<string, unknown>,
  TRun extends TypedClientRun<infer _I, infer O> ? O : Record<string, unknown>
>

// Overload 2: With JobDefinition for type inference (auto-filters by jobName)
export function useRuns<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined,
>(
  jobDefinition: JobDefinition<TName, TInput, TOutput>,
  options: Omit<UseRunsClientOptions, 'jobName'>,
): UseRunsClientResult<TInput, TOutput>

// Overload 3: Without type parameter (untyped, backward compatible)
export function useRuns(options: UseRunsClientOptions): UseRunsClientResult

// Implementation
export function useRuns<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined,
>(
  jobDefinitionOrOptions:
    | JobDefinition<TName, TInput, TOutput>
    | UseRunsClientOptions,
  optionsArg?: Omit<UseRunsClientOptions, 'jobName'>,
): UseRunsClientResult<TInput, TOutput> {
  // Determine if first argument is a JobDefinition using type guard
  const isJob = isJobDefinition(jobDefinitionOrOptions)

  const jobName = isJob
    ? jobDefinitionOrOptions.name
    : (jobDefinitionOrOptions as UseRunsClientOptions).jobName

  const options = isJob
    ? (optionsArg as Omit<UseRunsClientOptions, 'jobName'>)
    : (jobDefinitionOrOptions as UseRunsClientOptions)

  const { api, status, pageSize = 10 } = options

  const [runs, setRuns] = useState<TypedClientRun<TInput, TOutput>[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isMountedRef = useRef(true)
  const eventSourceRef = useRef<EventSource | null>(null)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (jobName) params.set('jobName', jobName)
      if (status) params.set('status', status)
      params.set('limit', String(pageSize + 1))
      params.set('offset', String(page * pageSize))

      const url = `${api}/runs?${params.toString()}`
      const response = await fetch(url)

      if (!response.ok) {
        throw new Error(`Failed to fetch runs: ${response.statusText}`)
      }

      const data = (await response.json()) as TypedClientRun<TInput, TOutput>[]

      if (isMountedRef.current) {
        setHasMore(data.length > pageSize)
        setRuns(data.slice(0, pageSize))
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
    }
  }, [api, jobName, status, pageSize, page])

  // Initial fetch
  useEffect(() => {
    isMountedRef.current = true
    refresh()

    return () => {
      isMountedRef.current = false
    }
  }, [refresh])

  // SSE subscription for first page only
  useEffect(() => {
    // Only subscribe to SSE on first page
    if (page !== 0) {
      // Clean up any existing connection when navigating away from first page
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
      return
    }

    // Build SSE URL
    const params = new URLSearchParams()
    if (jobName) params.set('jobName', jobName)
    const sseUrl = `${api}/runs/subscribe${params.toString() ? `?${params.toString()}` : ''}`

    const eventSource = new EventSource(sseUrl)
    eventSourceRef.current = eventSource

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RunUpdateEvent
        // On run lifecycle events, refresh the list
        if (
          data.type === 'run:trigger' ||
          data.type === 'run:start' ||
          data.type === 'run:complete' ||
          data.type === 'run:fail' ||
          data.type === 'run:cancel' ||
          data.type === 'run:retry'
        ) {
          refresh()
        }
        // On progress update, update the run in place
        if (data.type === 'run:progress') {
          setRuns((prev) =>
            prev.map((run) =>
              run.id === data.runId ? { ...run, progress: data.progress } : run,
            ),
          )
        }
        // On step complete, update currentStepIndex
        if (data.type === 'step:complete') {
          setRuns((prev) =>
            prev.map((run) =>
              run.id === data.runId
                ? { ...run, currentStepIndex: data.stepIndex + 1 }
                : run,
            ),
          )
        }
        // On step start or fail, refresh to get latest state
        if (data.type === 'step:start' || data.type === 'step:fail') {
          refresh()
        }
        // log:write is handled by useJobLogs, not useRuns
      } catch {
        // Ignore parse errors
      }
    }

    eventSource.onerror = () => {
      // EventSource will automatically reconnect
    }

    return () => {
      eventSource.close()
      eventSourceRef.current = null
    }
  }, [api, jobName, page, refresh])

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
    error,
    nextPage,
    prevPage,
    goToPage,
    refresh,
  }
}
