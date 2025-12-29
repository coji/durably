import type { LogEntry } from '../types'
import { useSSESubscription } from './use-sse-subscription'

export interface UseJobLogsClientOptions {
  /**
   * API endpoint URL (e.g., '/api/durably')
   */
  api: string
  /**
   * The run ID to subscribe to logs for
   */
  runId: string | null
  /**
   * Maximum number of logs to keep (default: unlimited)
   */
  maxLogs?: number
}

export interface UseJobLogsClientResult {
  /**
   * Whether the hook is ready (always true for client mode)
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
 * Hook for subscribing to logs from a run via server API.
 * Uses EventSource for SSE subscription.
 */
export function useJobLogs(
  options: UseJobLogsClientOptions,
): UseJobLogsClientResult {
  const { api, runId, maxLogs } = options

  const subscription = useSSESubscription(api, runId, { maxLogs })

  return {
    isReady: true,
    logs: subscription.logs,
    clearLogs: subscription.clearLogs,
  }
}
