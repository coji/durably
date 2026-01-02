import { useCallback, useEffect, useRef, useState } from 'react'
import type { Progress, RunStatus } from '../types'

/**
 * Run type for client mode (matches server response)
 */
export interface ClientRun {
  id: string
  jobName: string
  status: RunStatus
  input: unknown
  output: unknown | null
  error: string | null
  progress: Progress | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

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

export interface UseRunsClientResult {
  /**
   * List of runs for the current page
   */
  runs: ClientRun[]
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
 * @example
 * ```tsx
 * function RunHistory() {
 *   const { runs, page, hasMore, nextPage, prevPage, refresh } = useRuns({
 *     api: '/api/durably',
 *     jobName: 'import-csv',
 *     pageSize: 10,
 *   })
 *
 *   return (
 *     <div>
 *       {runs.map(run => (
 *         <div key={run.id}>{run.jobName}: {run.status}</div>
 *       ))}
 *       <button onClick={prevPage} disabled={page === 0}>Prev</button>
 *       <button onClick={nextPage} disabled={!hasMore}>Next</button>
 *       <button onClick={refresh}>Refresh</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useRuns(options: UseRunsClientOptions): UseRunsClientResult {
  const { api, jobName, status, pageSize = 10 } = options

  const [runs, setRuns] = useState<ClientRun[]>([])
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

      const data = (await response.json()) as ClientRun[]

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
