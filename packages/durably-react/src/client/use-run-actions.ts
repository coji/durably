import { useCallback } from 'react'
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
}

async function parseErrorResponse(
  response: Response,
  actionName: string,
): Promise<string> {
  let errorMessage = `Failed to ${actionName}: ${response.statusText}`
  try {
    const data: unknown = await response.json()
    if (
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      (data as { error: unknown }).error
    ) {
      errorMessage = String((data as { error: unknown }).error)
    }
  } catch {
    // Response is not JSON, use statusText
  }
  return errorMessage
}

/**
 * Hook for run actions via server API.
 *
 * @example
 * ```tsx
 * function RunActions({ runId, status }: { runId: string; status: string }) {
 *   const { retrigger, cancel } = useRunActions({
 *     api: '/api/durably',
 *   })
 *   const [isPending, startTransition] = useTransition()
 *
 *   return (
 *     <div>
 *       {status === 'failed' && (
 *         <button
 *           onClick={() =>
 *             startTransition(() =>
 *               // Handle errors in production (e.g. toast, local state)
 *               retrigger(runId).catch(console.error),
 *             )
 *           }
 *           disabled={isPending}
 *         >
 *           Run Again
 *         </button>
 *       )}
 *       {(status === 'pending' || status === 'leased') && (
 *         <button
 *           onClick={() =>
 *             startTransition(() =>
 *               cancel(runId).catch(console.error),
 *             )
 *           }
 *           disabled={isPending}
 *         >
 *           Cancel
 *         </button>
 *       )}
 *     </div>
 *   )
 * }
 * ```
 */
export function useRunActions(
  options: UseRunActionsClientOptions,
): UseRunActionsClientResult {
  const { api } = options

  const executeJson = useCallback(
    async <T>(
      url: string,
      actionName: string,
      init?: RequestInit,
    ): Promise<T> => {
      const response = await fetch(url, init)

      if (!response.ok) {
        const errorMessage = await parseErrorResponse(response, actionName)
        throw new Error(errorMessage)
      }

      return (await response.json()) as T
    },
    [],
  )

  const retrigger = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      const data = await executeJson<{ runId?: string }>(
        `${api}/retrigger?runId=${enc}`,
        'retrigger',
        { method: 'POST' },
      )
      if (!data.runId) {
        throw new Error('Failed to retrigger: missing runId in response')
      }
      return data.runId
    },
    [api, executeJson],
  )

  const cancel = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeJson(`${api}/cancel?runId=${enc}`, 'cancel', {
        method: 'POST',
      })
    },
    [api, executeJson],
  )

  const deleteRun = useCallback(
    async (runId: string) => {
      const enc = encodeURIComponent(runId)
      await executeJson(`${api}/run?runId=${enc}`, 'delete', {
        method: 'DELETE',
      })
    },
    [api, executeJson],
  )

  const getRun = useCallback(
    async (runId: string): Promise<ClientRun | null> => {
      const enc = encodeURIComponent(runId)
      const response = await fetch(`${api}/run?runId=${enc}`)

      if (response.status === 404) {
        return null
      }

      if (!response.ok) {
        const errorMessage = await parseErrorResponse(response, 'get run')
        throw new Error(errorMessage)
      }

      return (await response.json()) as ClientRun
    },
    [api],
  )

  const getSteps = useCallback(
    async (runId: string): Promise<StepRecord[]> => {
      const enc = encodeURIComponent(runId)
      return executeJson<StepRecord[]>(`${api}/steps?runId=${enc}`, 'get steps')
    },
    [api, executeJson],
  )

  return {
    retrigger,
    cancel,
    deleteRun,
    getRun,
    getSteps,
  }
}
