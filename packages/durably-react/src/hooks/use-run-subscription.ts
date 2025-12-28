import type { Durably } from '@coji/durably'
import { useEffect, useRef, useState } from 'react'
import type { LogEntry, Progress, RunStatus } from '../types'

export interface RunSubscriptionState<TOutput = unknown> {
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
}

export interface UseRunSubscriptionOptions {
  /**
   * Maximum number of logs to keep (0 = unlimited)
   */
  maxLogs?: number
}

export interface UseRunSubscriptionResult<
  TOutput = unknown,
> extends RunSubscriptionState<TOutput> {
  /**
   * Clear all logs
   */
  clearLogs: () => void
  /**
   * Reset all state
   */
  reset: () => void
}

/**
 * Internal hook for subscribing to run events.
 * Shared by useJob, useJobRun, and useJobLogs.
 */
export function useRunSubscription<TOutput = unknown>(
  durably: Durably | null,
  runId: string | null,
  options?: UseRunSubscriptionOptions,
): UseRunSubscriptionResult<TOutput> {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [output, setOutput] = useState<TOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)

  // Use ref to track the latest runId for event filtering
  const runIdRef = useRef<string | null>(runId)
  runIdRef.current = runId

  const maxLogs = options?.maxLogs ?? 0

  // Subscribe to events
  useEffect(() => {
    if (!durably || !runId) return

    const unsubscribes: (() => void)[] = []

    unsubscribes.push(
      durably.on('run:start', (event) => {
        if (event.runId !== runIdRef.current) return
        setStatus('running')
      }),
    )

    unsubscribes.push(
      durably.on('run:complete', (event) => {
        if (event.runId !== runIdRef.current) return
        setStatus('completed')
        setOutput(event.output as TOutput)
      }),
    )

    unsubscribes.push(
      durably.on('run:fail', (event) => {
        if (event.runId !== runIdRef.current) return
        setStatus('failed')
        setError(event.error)
      }),
    )

    unsubscribes.push(
      durably.on('run:progress', (event) => {
        if (event.runId !== runIdRef.current) return
        setProgress(event.progress)
      }),
    )

    unsubscribes.push(
      durably.on('log:write', (event) => {
        if (event.runId !== runIdRef.current) return
        setLogs((prev) => {
          const newLog: LogEntry = {
            id: crypto.randomUUID(),
            runId: event.runId,
            stepName: event.stepName,
            level: event.level,
            message: event.message,
            data: event.data,
            timestamp: new Date().toISOString(),
          }
          const newLogs = [...prev, newLog]
          // Apply maxLogs limit if set
          if (maxLogs > 0 && newLogs.length > maxLogs) {
            return newLogs.slice(-maxLogs)
          }
          return newLogs
        })
      }),
    )

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [durably, runId, maxLogs])

  const clearLogs = () => {
    setLogs([])
  }

  const reset = () => {
    setStatus(null)
    setOutput(null)
    setError(null)
    setLogs([])
    setProgress(null)
  }

  return {
    status,
    output,
    error,
    logs,
    progress,
    clearLogs,
    reset,
  }
}
