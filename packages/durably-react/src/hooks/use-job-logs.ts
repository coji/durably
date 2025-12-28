import { useDurably } from '../context'
import type { LogEntry } from '../types'
import { useRunSubscription } from './use-run-subscription'

export interface UseJobLogsOptions {
  /**
   * The run ID to subscribe to logs for
   */
  runId: string | null
  /**
   * Maximum number of logs to keep (default: unlimited)
   */
  maxLogs?: number
}

export interface UseJobLogsResult {
  /**
   * Whether the hook is ready (Durably is initialized)
   */
  isReady: boolean
  /**
   * Logs collected during execution
   */
  logs: LogEntry[]
  /**
   * Clear all logs
   */
  clearLogs: () => void
}

/**
 * Hook for subscribing to logs from a run.
 * Use this when you only need logs, not full run status.
 */
export function useJobLogs(options: UseJobLogsOptions): UseJobLogsResult {
  const { durably, isReady: isDurablyReady } = useDurably()
  const { runId, maxLogs } = options

  const subscription = useRunSubscription(durably, runId, { maxLogs })

  return {
    isReady: isDurablyReady,
    logs: subscription.logs,
    clearLogs: subscription.clearLogs,
  }
}
