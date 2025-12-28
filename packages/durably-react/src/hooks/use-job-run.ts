import { useEffect, useRef } from 'react'
import { useDurably } from '../context'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useRunSubscription } from './use-run-subscription'

export interface UseJobRunOptions {
  /**
   * The run ID to subscribe to
   */
  runId: string | null
}

export interface UseJobRunResult<TOutput = unknown> {
  /**
   * Whether the hook is ready (Durably is initialized)
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
}

/**
 * Hook for subscribing to an existing run by ID.
 * Use this when you have a runId and want to track its status.
 */
export function useJobRun<TOutput = unknown>(
  options: UseJobRunOptions,
): UseJobRunResult<TOutput> {
  const { durably, isReady: isDurablyReady } = useDurably()
  const { runId } = options

  const subscription = useRunSubscription<TOutput>(durably, runId)

  // Fetch initial state when runId changes
  const fetchedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!durably || !runId || fetchedRef.current.has(runId)) return

    // Mark as fetched to avoid duplicate fetches
    fetchedRef.current.add(runId)

    // Try to fetch current run state
    // Note: We need to use internal APIs or polling here
    // For now, we rely on event-based updates
  }, [durably, runId])

  return {
    isReady: isDurablyReady,
    status: subscription.status,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isRunning: subscription.status === 'running',
    isPending: subscription.status === 'pending',
    isCompleted: subscription.status === 'completed',
    isFailed: subscription.status === 'failed',
  }
}
