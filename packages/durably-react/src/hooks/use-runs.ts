import type { Run } from '@coji/durably'
import { useCallback, useEffect, useState } from 'react'
import { useDurably } from '../context'

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

export interface UseRunsResult {
  /**
   * Whether the hook is ready (Durably is initialized)
   */
  isReady: boolean
  /**
   * List of runs for the current page
   */
  runs: Run[]
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
 * @example
 * ```tsx
 * function Dashboard() {
 *   const { runs, page, hasMore, nextPage, prevPage, isLoading } = useRuns({
 *     pageSize: 20,
 *   })
 *
 *   return (
 *     <div>
 *       {runs.map(run => (
 *         <div key={run.id}>{run.jobName}: {run.status}</div>
 *       ))}
 *       <button onClick={prevPage} disabled={page === 0}>Prev</button>
 *       <button onClick={nextPage} disabled={!hasMore}>Next</button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useRuns(options?: UseRunsOptions): UseRunsResult {
  const { durably, isReady: isDurablyReady } = useDurably()
  const pageSize = options?.pageSize ?? 10
  const realtime = options?.realtime ?? true

  const [runs, setRuns] = useState<Run[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!durably) return

    setIsLoading(true)
    try {
      const data = await durably.getRuns({
        jobName: options?.jobName,
        status: options?.status,
        limit: pageSize + 1,
        offset: page * pageSize,
      })
      setHasMore(data.length > pageSize)
      setRuns(data.slice(0, pageSize))
    } finally {
      setIsLoading(false)
    }
  }, [durably, options?.jobName, options?.status, pageSize, page])

  // Initial fetch and subscribe to events
  useEffect(() => {
    if (!durably || !isDurablyReady) return

    refresh()

    if (!realtime) return

    const unsubscribes = [
      durably.on('run:trigger', refresh),
      durably.on('run:start', refresh),
      durably.on('run:complete', refresh),
      durably.on('run:fail', refresh),
      durably.on('run:cancel', refresh),
      durably.on('run:retry', refresh),
    ]

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [durably, isDurablyReady, refresh, realtime])

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
    isReady: isDurablyReady,
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
