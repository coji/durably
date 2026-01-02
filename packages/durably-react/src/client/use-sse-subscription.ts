import { useCallback, useEffect, useRef, useState } from 'react'
import type { DurablyEvent, LogEntry, Progress, RunStatus } from '../types'

export interface SSESubscriptionState<TOutput = unknown> {
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
}

export interface UseSSESubscriptionOptions {
  /**
   * Maximum number of logs to keep (0 = unlimited)
   */
  maxLogs?: number
}

export interface UseSSESubscriptionResult<
  TOutput = unknown,
> extends SSESubscriptionState<TOutput> {
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
 * Internal hook for subscribing to run events via SSE.
 * Used by client-mode hooks (useJob, useJobRun, useJobLogs).
 */
export function useSSESubscription<TOutput = unknown>(
  api: string | null,
  runId: string | null,
  options?: UseSSESubscriptionOptions,
): UseSSESubscriptionResult<TOutput> {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [output, setOutput] = useState<TOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)

  const eventSourceRef = useRef<EventSource | null>(null)
  const runIdRef = useRef<string | null>(runId)
  const prevRunIdRef = useRef<string | null>(null)

  const maxLogs = options?.maxLogs ?? 0

  // Reset state when runId changes
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId
    // Only reset if this isn't the initial render (runIdRef already set)
    if (runIdRef.current !== runId) {
      setStatus(null)
      setOutput(null)
      setError(null)
      setLogs([])
      setProgress(null)
    }
  }
  runIdRef.current = runId

  // Subscribe to SSE events
  useEffect(() => {
    if (!api || !runId) return

    const url = `${api}/subscribe?runId=${encodeURIComponent(runId)}`
    const eventSource = new EventSource(url)
    eventSourceRef.current = eventSource

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DurablyEvent
        if (data.runId !== runIdRef.current) return

        switch (data.type) {
          case 'run:start':
            setStatus('running')
            break
          case 'run:complete':
            setStatus('completed')
            setOutput(data.output as TOutput)
            break
          case 'run:fail':
            setStatus('failed')
            setError(data.error)
            break
          case 'run:cancel':
            setStatus('cancelled')
            break
          case 'run:retry':
            setStatus('pending')
            setError(null)
            break
          case 'run:progress':
            setProgress(data.progress)
            break
          case 'log:write':
            setLogs((prev) => {
              const newLog: LogEntry = {
                id: crypto.randomUUID(),
                runId: data.runId,
                stepName: null,
                level: data.level,
                message: data.message,
                data: data.data,
                timestamp: new Date().toISOString(),
              }
              const newLogs = [...prev, newLog]
              if (maxLogs > 0 && newLogs.length > maxLogs) {
                return newLogs.slice(-maxLogs)
              }
              return newLogs
            })
            break
        }
      } catch {
        // Ignore parse errors
      }
    }

    eventSource.onerror = () => {
      setError('Connection failed')
      eventSource.close()
    }

    return () => {
      eventSource.close()
      eventSourceRef.current = null
    }
  }, [api, runId, maxLogs])

  const clearLogs = useCallback(() => {
    setLogs([])
  }, [])

  const reset = useCallback(() => {
    setStatus(null)
    setOutput(null)
    setError(null)
    setLogs([])
    setProgress(null)
  }, [])

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
