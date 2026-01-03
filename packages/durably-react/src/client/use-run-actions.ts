import { useCallback, useState } from 'react'

/**
 * Run record returned from the server API
 */
export interface RunRecord {
  id: string
  jobName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  payload: unknown
  output: unknown | null
  error: string | null
  progress: { current: number; total?: number; message?: string } | null
  currentStepIndex: number
  stepCount: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

/**
 * Step record returned from the server API
 */
export interface StepRecord {
  name: string
  status: 'completed' | 'failed'
  output: unknown
}

export interface UseRunActionsClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
}

export interface UseRunActionsClientResult {
  /**
   * Retry a failed or cancelled run
   */
  retry: (runId: string) => Promise<void>
  /**
   * Cancel a pending or running run
   */
  cancel: (runId: string) => Promise<void>
  /**
   * Delete a run (only completed, failed, or cancelled runs)
   */
  deleteRun: (runId: string) => Promise<void>
  /**
   * Get a single run by ID
   */
  getRun: (runId: string) => Promise<RunRecord | null>
  /**
   * Get steps for a run
   */
  getSteps: (runId: string) => Promise<StepRecord[]>
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
          let errorMessage = `Failed to retry: ${response.statusText}`
          try {
            const data = await response.json()
            if (data.error) {
              errorMessage = data.error
            }
          } catch {
            // Response is not JSON, use statusText
          }
          throw new Error(errorMessage)
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
          let errorMessage = `Failed to cancel: ${response.statusText}`
          try {
            const data = await response.json()
            if (data.error) {
              errorMessage = data.error
            }
          } catch {
            // Response is not JSON, use statusText
          }
          throw new Error(errorMessage)
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

  const deleteRun = useCallback(
    async (runId: string) => {
      setIsLoading(true)
      setError(null)

      try {
        const url = `${api}/run?runId=${encodeURIComponent(runId)}`
        const response = await fetch(url, { method: 'DELETE' })

        if (!response.ok) {
          let errorMessage = `Failed to delete: ${response.statusText}`
          try {
            const data = await response.json()
            if (data.error) {
              errorMessage = data.error
            }
          } catch {
            // Response is not JSON, use statusText
          }
          throw new Error(errorMessage)
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

  const getRun = useCallback(
    async (runId: string): Promise<RunRecord | null> => {
      setIsLoading(true)
      setError(null)

      try {
        const url = `${api}/run?runId=${encodeURIComponent(runId)}`
        const response = await fetch(url)

        if (response.status === 404) {
          return null
        }

        if (!response.ok) {
          let errorMessage = `Failed to get run: ${response.statusText}`
          try {
            const data = await response.json()
            if (data.error) {
              errorMessage = data.error
            }
          } catch {
            // Response is not JSON, use statusText
          }
          throw new Error(errorMessage)
        }

        return (await response.json()) as RunRecord
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

  const getSteps = useCallback(
    async (runId: string): Promise<StepRecord[]> => {
      setIsLoading(true)
      setError(null)

      try {
        const url = `${api}/steps?runId=${encodeURIComponent(runId)}`
        const response = await fetch(url)

        if (!response.ok) {
          let errorMessage = `Failed to get steps: ${response.statusText}`
          try {
            const data = await response.json()
            if (data.error) {
              errorMessage = data.error
            }
          } catch {
            // Response is not JSON, use statusText
          }
          throw new Error(errorMessage)
        }

        return (await response.json()) as StepRecord[]
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
    deleteRun,
    getRun,
    getSteps,
    isLoading,
    error,
  }
}
