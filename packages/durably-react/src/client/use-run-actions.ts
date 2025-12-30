import { useCallback, useState } from 'react'

export interface UseRunActionsClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
}

export interface UseRunActionsClientResult {
  /**
   * Retry a failed run
   */
  retry: (runId: string) => Promise<void>
  /**
   * Cancel a pending or running run
   */
  cancel: (runId: string) => Promise<void>
  /**
   * Whether an action is in progress
   */
  isLoading: boolean
  /**
   * Error message from last action
   */
  error: string | null
}

/**
 * Hook for run actions (retry, cancel) via server API.
 *
 * @example
 * ```tsx
 * function RunActions({ runId, status }: { runId: string; status: string }) {
 *   const { retry, cancel, isLoading, error } = useRunActions({
 *     api: '/api/durably',
 *   })
 *
 *   return (
 *     <div>
 *       {status === 'failed' && (
 *         <button onClick={() => retry(runId)} disabled={isLoading}>
 *           Retry
 *         </button>
 *       )}
 *       {(status === 'pending' || status === 'running') && (
 *         <button onClick={() => cancel(runId)} disabled={isLoading}>
 *           Cancel
 *         </button>
 *       )}
 *       {error && <span className="error">{error}</span>}
 *     </div>
 *   )
 * }
 * ```
 */
export function useRunActions(
  options: UseRunActionsClientOptions,
): UseRunActionsClientResult {
  const { api } = options

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const retry = useCallback(
    async (runId: string) => {
      setIsLoading(true)
      setError(null)

      try {
        const url = `${api}/retry?runId=${encodeURIComponent(runId)}`
        const response = await fetch(url, { method: 'POST' })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(
            data.error || `Failed to retry: ${response.statusText}`,
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [api],
  )

  const cancel = useCallback(
    async (runId: string) => {
      setIsLoading(true)
      setError(null)

      try {
        const url = `${api}/cancel?runId=${encodeURIComponent(runId)}`
        const response = await fetch(url, { method: 'POST' })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(
            data.error || `Failed to cancel: ${response.statusText}`,
          )
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [api],
  )

  return {
    retry,
    cancel,
    isLoading,
    error,
  }
}
