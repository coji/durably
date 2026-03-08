import { useDurably } from '../context'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useRunSubscription } from './use-run-subscription'

// Note: Unlike UseJobRunClientOptions (client mode), this interface intentionally
// omits onStart/onComplete/onFail callbacks. In browser mode, use durably.on()
// directly for event callbacks.
export interface UseJobRunOptions {
  /**
   * The run ID to subscribe to
   */
  runId: string | null
}

export interface UseJobRunResult<TOutput = unknown> {
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
   * Whether a run is currently leased (being executed by a worker)
   */
  isLeased: boolean
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
 * Hook for subscribing to an existing run by ID.
 * Use this when you have a runId and want to track its status.
 */
export function useJobRun<TOutput = unknown>(
  options: UseJobRunOptions,
): UseJobRunResult<TOutput> {
  const { durably } = useDurably()
  const { runId } = options

  const subscription = useRunSubscription<TOutput>(durably, runId)

  // If we have a runId but no status yet, treat as pending
  const effectiveStatus = subscription.status ?? (runId ? 'pending' : null)

  return {
    status: effectiveStatus,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isLeased: effectiveStatus === 'leased',
    isPending: effectiveStatus === 'pending',
    isCompleted: effectiveStatus === 'completed',
    isFailed: effectiveStatus === 'failed',
    isCancelled: effectiveStatus === 'cancelled',
  }
}
