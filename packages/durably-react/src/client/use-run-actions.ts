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
   * Cancel a pending or leased run
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
   * Whether a mutating action is in progress for the given run
   */
  isLoadingFor: (runId: string) => boolean
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
 *   const { retrigger, cancel, isLoadingFor, error } = useRunActions({
 *     api: '/api/durably',
 *   })
 *
 *   return (
 *     <div>
 *       {status === 'failed' && (
 *         <button
 *           onClick={() => retrigger(runId)}
 *           disabled={isLoadingFor(runId)}
 *         >
 *           Run Again
 *         </button>
 *       )}
 *       {(status === 'pending' || status === 'leased') && (
 *         <button onClick={() => cancel(runId)} disabled={isLoadingFor(runId)}>
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

  const [loadingRunIds, setLoadingRunIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [error, setError] = useState<string | null>(null)

  const executeAction = useCallback(
    async <T>(
      url: string,
      actionName: string,
      init?: RequestInit,
      runId?: string,
    ): Promise<T> => {
      setError(null)

      if (runId) {
        setLoadingRunIds((prev) => {
          const next = new Set(prev)
          next.add(runId)
          return next
        })
      }

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
        if (runId) {
          setLoadingRunIds((prev) => {
            const next = new Set(prev)
            next.delete(runId)
            return next
          })
        }
      }
    },
    [],
  )

  const isLoadingFor = useCallback(
    (runId: string) => loadingRunIds.has(runId),
    [loadingRunIds],
  )

  const retrigger = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      const data = await executeAction<{ runId?: string }>(
        `${api}/retrigger?runId=${enc}`,
        'retrigger',
        { method: 'POST' },
        runId,
      )
      if (!data.runId) {
        const message = 'Failed to retrigger: missing runId in response'
        setError(message)
        throw new Error(message)
      }
      return data.runId
    },
    [api, executeAction],
  )

  const cancel = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeAction(
        `${api}/cancel?runId=${enc}`,
        'cancel',
        {
          method: 'POST',
        },
        runId,
      )
    },
    [api, executeAction],
  )

  const deleteRun = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeAction(
        `${api}/run?runId=${enc}`,
        'delete',
        {
          method: 'DELETE',
        },
        runId,
      )
    },
    [api, executeAction],
  )

  const getRun = useCallback(
    async (runId: string): Promise<ClientRun | null> => {
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
    isLoadingFor,
    error,
  }
}
