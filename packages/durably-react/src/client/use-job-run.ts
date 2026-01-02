import { useEffect, useRef } from 'react'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useSSESubscription } from './use-sse-subscription'

export interface UseJobRunClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
  /**
   * The run ID to subscribe to
   */
  runId: string | null
  /**
   * Callback when run starts (transitions to pending/running)
   */
  onStart?: () => void
  /**
   * Callback when run completes successfully
   */
  onComplete?: () => void
  /**
   * Callback when run fails
   */
  onFail?: () => void
}

export interface UseJobRunClientResult<TOutput = unknown> {
  /**
   * Whether the hook is ready (always true for client mode)
   */
  isReady: boolean
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
   * Whether the run was cancelled
   */
  isCancelled: boolean
}

/**
 * Hook for subscribing to an existing run via server API.
 * Uses EventSource for SSE subscription.
 */
export function useJobRun<TOutput = unknown>(
  options: UseJobRunClientOptions,
): UseJobRunClientResult<TOutput> {
  const { api, runId, onStart, onComplete, onFail } = options

  const subscription = useSSESubscription<TOutput>(api, runId)

  // If we have a runId but no status yet, treat as pending
  const effectiveStatus = subscription.status ?? (runId ? 'pending' : null)

  const isCompleted = effectiveStatus === 'completed'
  const isFailed = effectiveStatus === 'failed'
  const isPending = effectiveStatus === 'pending'
  const isRunning = effectiveStatus === 'running'
  const isCancelled = effectiveStatus === 'cancelled'

  // Track previous status to detect transitions
  const prevStatusRef = useRef<RunStatus | null>(null)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    prevStatusRef.current = subscription.status

    // Only fire callbacks on status transitions
    if (prevStatus !== subscription.status) {
      // Fire onStart when transitioning from null to pending/running
      if (prevStatus === null && (isPending || isRunning) && onStart) {
        onStart()
      }
      if (isCompleted && onComplete) {
        onComplete()
      }
      if (isFailed && onFail) {
        onFail()
      }
    }
  }, [
    subscription.status,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
    onStart,
    onComplete,
    onFail,
  ])

  return {
    isReady: true,
    status: effectiveStatus,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isRunning,
    isPending,
    isCompleted,
    isFailed,
    isCancelled,
  }
}
