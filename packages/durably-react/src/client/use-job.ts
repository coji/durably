import { useCallback, useEffect, useState } from 'react'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useSSESubscription } from './use-sse-subscription'

export interface UseJobClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
  /**
   * Job name to trigger
   */
  jobName: string
  /**
   * Initial Run ID to subscribe to (for reconnection scenarios)
   * When provided, the hook will immediately start subscribing to this run
   */
  initialRunId?: string
}

export interface UseJobClientResult<TInput, TOutput> {
  /**
   * Whether the hook is ready (always true for client mode)
   */
  isReady: boolean
  /**
   * Trigger the job with the given input
   */
  trigger: (input: TInput) => Promise<{ runId: string }>
  /**
   * Trigger and wait for completion
   */
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  /**
   * Current run status
   */
  status: RunStatus | null
  /**
   * Output from completed run
   */
  output: TOutput | null
  /**
   * Error message from failed run
   */
  error: string | null
  /**
   * Logs collected during execution
   */
  logs: LogEntry[]
  /**
   * Current progress
   */
  progress: Progress | null
  /**
   * Whether a run is currently running
   */
  isRunning: boolean
  /**
   * Whether a run is pending
   */
  isPending: boolean
  /**
   * Whether the run completed successfully
   */
  isCompleted: boolean
  /**
   * Whether the run failed
   */
  isFailed: boolean
  /**
   * Current run ID
   */
  currentRunId: string | null
  /**
   * Reset all state
   */
  reset: () => void
}

/**
 * Hook for triggering and subscribing to jobs via server API.
 * Uses fetch for triggering and EventSource for SSE subscription.
 */
export function useJob<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(options: UseJobClientOptions): UseJobClientResult<TInput, TOutput> {
  const { api, jobName, initialRunId } = options

  const [currentRunId, setCurrentRunId] = useState<string | null>(
    initialRunId ?? null,
  )
  const [isPending, setIsPending] = useState(false)

  const subscription = useSSESubscription<TOutput>(api, currentRunId)

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      // Reset state
      subscription.reset()
      setIsPending(true)

      const response = await fetch(`${api}/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jobName, input }),
      })

      if (!response.ok) {
        setIsPending(false)
        const errorText = await response.text()
        throw new Error(errorText || `HTTP ${response.status}`)
      }

      const { runId } = (await response.json()) as { runId: string }
      setCurrentRunId(runId)

      return { runId }
    },
    [api, jobName, subscription.reset],
  )

  const triggerAndWait = useCallback(
    async (input: TInput): Promise<{ runId: string; output: TOutput }> => {
      const { runId } = await trigger(input)

      return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
          if (subscription.status === 'completed' && subscription.output) {
            clearInterval(checkInterval)
            resolve({ runId, output: subscription.output })
          } else if (subscription.status === 'failed') {
            clearInterval(checkInterval)
            reject(new Error(subscription.error ?? 'Job failed'))
          } else if (subscription.status === 'cancelled') {
            clearInterval(checkInterval)
            reject(new Error('Job cancelled'))
          }
        }, 50)
      })
    },
    [trigger, subscription.status, subscription.output, subscription.error],
  )

  const reset = useCallback(() => {
    subscription.reset()
    setCurrentRunId(null)
    setIsPending(false)
  }, [subscription.reset])

  // Compute effective status (pending overrides null when we've triggered but SSE hasn't started)
  const effectiveStatus = subscription.status ?? (isPending ? 'pending' : null)

  // Clear pending when we get a real status
  useEffect(() => {
    if (subscription.status && isPending) {
      setIsPending(false)
    }
  }, [subscription.status, isPending])

  return {
    isReady: true,
    trigger,
    triggerAndWait,
    status: effectiveStatus,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isRunning: effectiveStatus === 'running',
    isPending: effectiveStatus === 'pending',
    isCompleted: effectiveStatus === 'completed',
    isFailed: effectiveStatus === 'failed',
    currentRunId,
    reset,
  }
}
