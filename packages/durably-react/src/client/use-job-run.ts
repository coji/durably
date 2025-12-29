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
}

/**
 * Hook for subscribing to an existing run via server API.
 * Uses EventSource for SSE subscription.
 */
export function useJobRun<TOutput = unknown>(
  options: UseJobRunClientOptions,
): UseJobRunClientResult<TOutput> {
  const { api, runId } = options

  const subscription = useSSESubscription<TOutput>(api, runId)

  return {
    isReady: true,
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
