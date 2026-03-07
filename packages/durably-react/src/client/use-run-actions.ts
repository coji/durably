import { useCallback, useState } from 'react'
import type { ClientRun } from '../types'

/**
 * Step record returned from the server API
 */
export interface StepRecord {
  name: string
  status: 'completed' | 'failed' | 'cancelled'
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
   * Create a fresh run from a completed, failed, or cancelled run
   */
  retrigger: (runId: string) => Promise<string>
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
  getRun: (runId: string) => Promise<ClientRun | null>
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
 * Hook for run actions via server API.
 *
 * @example
 * ```tsx
 * function RunActions({ runId, status }: { runId: string; status: string }) {
 *   const { retrigger, cancel, isLoading, error } = useRunActions({
 *     api: '/api/durably',
 *   })
 *
 *   return (
 *     <div>
 *       {status === 'failed' && (
 *         <button onClick={() => retrigger(runId)} disabled={isLoading}>
 *           Run Again
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

  const executeAction = useCallback(
    async <T>(
      url: string,
      actionName: string,
      init?: RequestInit,
    ): Promise<T> => {
      setIsLoading(true)
      setError(null)

      try {
        const response = await fetch(url, init)

        if (!response.ok) {
          let errorMessage = `Failed to ${actionName}: ${response.statusText}`
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

        return (await response.json()) as T
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [],
  )

  const retrigger = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      const data = await executeAction<{ runId?: string }>(
        `${api}/retrigger?runId=${enc}`,
        'retrigger',
        { method: 'POST' },
      )
      if (!data.runId) {
        throw new Error('Failed to retrigger: missing runId in response')
      }
      return data.runId
    },
    [api, executeAction],
  )

  const cancel = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeAction(`${api}/cancel?runId=${enc}`, 'cancel', {
        method: 'POST',
      })
    },
    [api, executeAction],
  )

  const deleteRun = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeAction(`${api}/run?runId=${enc}`, 'delete', {
        method: 'DELETE',
      })
    },
    [api, executeAction],
  )

  const getRun = useCallback(
    async (runId: string): Promise<ClientRun | null> => {
      setIsLoading(true)
      setError(null)

      try {
        const enc = encodeURIComponent(runId)
        const response = await fetch(`${api}/run?runId=${enc}`)

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

        return (await response.json()) as ClientRun
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
      const enc = encodeURIComponent(runId)
      return executeAction<StepRecord[]>(
        `${api}/steps?runId=${enc}`,
        'get steps',
      )
    },
    [api, executeAction],
  )

  return {
    retrigger,
    cancel,
    deleteRun,
    getRun,
    getSteps,
    isLoading,
    error,
  }
}
