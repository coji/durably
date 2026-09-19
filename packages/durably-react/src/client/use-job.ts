import type { TriggerOptions } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createSSEEventSubscriber } from '../shared/sse-event-subscriber'
import { useStableValue } from '../shared/use-stable-value'
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
  /**
   * Automatically resume tracking a leased/pending job on mount
   * @default true
   */
  autoResume?: boolean
  /**
   * Automatically switch to tracking the latest triggered job
   * @default true
   */
  followLatest?: boolean
  /**
   * Optional scope to filter active runs and events by labels
   */
  scope?: { labels: Record<string, string> }
  /**
   * Options passed to trigger() and triggerAndWait()
   */
  triggerOptions?: TriggerOptions<Record<string, string>>
}

export interface UseJobClientResult<TInput, TOutput> {
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
  /**
   * Whether the run reached a terminal status (completed, failed, or cancelled)
   */
  isTerminal: boolean
  /**
   * Whether the run is pending or leased (actively queued or executing)
   */
  isActive: boolean
  /**
   * Whether initial scoped active-run resolution is currently in progress
   */
  isResolving: boolean
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
  const {
    api,
    jobName,
    initialRunId,
    autoResume = true,
    followLatest = true,
  } = options

  const stableScope = useStableValue(options.scope)
  const stableTriggerOptions = useStableValue(options.triggerOptions)

  const [currentRunId, setCurrentRunId] = useState<string | null>(
    initialRunId ?? null,
  )
  const [isPending, setIsPending] = useState(false)
  const [hydratedStatus, setHydratedStatus] = useState<RunStatus | null>(null)

  const resolutionEpochRef = useRef(0)
  const prevScopeRef = useRef(stableScope)
  const [isResolving, setIsResolving] = useState(autoResume && !initialRunId)

  // Track if user has triggered a run (to prevent autoResume from overwriting)
  const hasUserTriggered = useRef(false)
  const waitUnsubscribesRef = useRef(new Set<() => void>())

  const subscription = useSSESubscription<TOutput>(api, currentRunId)

  // Handle scope changes
  useEffect(() => {
    if (prevScopeRef.current !== stableScope) {
      prevScopeRef.current = stableScope
      resolutionEpochRef.current++
      hasUserTriggered.current = false
      if (!initialRunId) {
        subscription.reset()
        setCurrentRunId(null)
        setHydratedStatus(null)
        setIsPending(false)
        if (autoResume) {
          setIsResolving(true)
        } else {
          setIsResolving(false)
        }
      }
    }
  }, [stableScope, initialRunId, autoResume, subscription.reset])

  // Handle initialRunId updates
  useEffect(() => {
    if (!initialRunId) return
    setIsResolving(false)
    setCurrentRunId(initialRunId)
  }, [initialRunId])

  // Auto-resume: fetch leased/pending job on mount / scope change
  useEffect(() => {
    if (!autoResume) {
      setIsResolving(false)
      return
    }
    if (initialRunId) {
      setIsResolving(false)
      return // Skip if initialRunId is provided
    }

    const abortController = new AbortController()
    let cancelled = false
    const epoch = resolutionEpochRef.current

    const findActiveRun = async () => {
      const signal = abortController.signal

      const leasedParams = new URLSearchParams({
        jobName,
        status: 'leased',
        limit: '1',
      })
      const pendingParams = new URLSearchParams({
        jobName,
        status: 'pending',
        limit: '1',
      })

      if (stableScope?.labels) {
        for (const [key, value] of Object.entries(stableScope.labels)) {
          leasedParams.append(`label.${key}`, value)
          pendingParams.append(`label.${key}`, value)
        }
      }

      // Fetch leased and pending in parallel
      const [leasedRes, pendingRes] = await Promise.all([
        fetch(`${api}/runs?${leasedParams}`, { signal }),
        fetch(`${api}/runs?${pendingParams}`, { signal }),
      ])

      if (hasUserTriggered.current || resolutionEpochRef.current !== epoch) {
        return
      }

      // Prefer leased over pending
      if (leasedRes.ok) {
        const runs = (await leasedRes.json()) as Array<{
          id: string
          status?: RunStatus
        }>
        if (hasUserTriggered.current || resolutionEpochRef.current !== epoch)
          return
        if (runs.length > 0) {
          setCurrentRunId(runs[0].id)
          setHydratedStatus(runs[0].status ?? 'leased')
          setIsResolving(false)
          return
        }
      }

      if (pendingRes.ok) {
        const runs = (await pendingRes.json()) as Array<{
          id: string
          status?: RunStatus
        }>
        if (hasUserTriggered.current || resolutionEpochRef.current !== epoch)
          return
        if (runs.length > 0) {
          setCurrentRunId(runs[0].id)
          setHydratedStatus(runs[0].status ?? 'pending')
          setIsResolving(false)
          return
        }
      }

      setIsResolving(false)
    }

    findActiveRun().catch((err) => {
      if (cancelled) return
      if (err.name !== 'AbortError') {
        console.error('autoResume error:', err)
      }
      if (resolutionEpochRef.current === epoch) {
        setIsResolving(false)
      }
    })

    return () => {
      cancelled = true
      abortController.abort()
    }
  }, [api, jobName, autoResume, initialRunId, stableScope])

  // Follow latest: subscribe to job-level SSE for run:trigger/run:leased/run:coalesced events
  useEffect(() => {
    if (!followLatest) return

    const params = new URLSearchParams({ jobName })
    if (stableScope?.labels) {
      for (const [key, value] of Object.entries(stableScope.labels)) {
        params.append(`label.${key}`, value)
      }
    }
    const eventSource = new EventSource(`${api}/runs/subscribe?${params}`)

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string
          runId?: string
          status?: RunStatus
        }
        if (
          (data.type === 'run:trigger' ||
            data.type === 'run:coalesced' ||
            data.type === 'run:leased') &&
          data.runId
        ) {
          resolutionEpochRef.current++
          setIsResolving(false)
          setCurrentRunId(data.runId)
          if (data.type === 'run:trigger') {
            setHydratedStatus('pending')
          } else if (data.type === 'run:leased') {
            setHydratedStatus('leased')
          } else if (data.type === 'run:coalesced' && data.status) {
            setHydratedStatus(data.status)
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    eventSource.onerror = () => {
      // SSE connection error - EventSource auto-reconnects
    }

    return () => {
      eventSource.close()
    }
  }, [api, jobName, followLatest, stableScope])

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      hasUserTriggered.current = true
      resolutionEpochRef.current++
      setIsResolving(false)

      // Reset state
      subscription.reset()
      setHydratedStatus(null)
      setIsPending(true)

      const body: Record<string, unknown> = {
        jobName,
        input,
      }
      if (stableTriggerOptions?.idempotencyKey) {
        body.idempotencyKey = stableTriggerOptions.idempotencyKey
      }
      if (stableTriggerOptions?.concurrencyKey) {
        body.concurrencyKey = stableTriggerOptions.concurrencyKey
      }
      if (stableTriggerOptions?.labels) {
        body.labels = stableTriggerOptions.labels
      }
      if (stableTriggerOptions?.coalesce) {
        body.coalesce = stableTriggerOptions.coalesce
      }

      const response = await fetch(`${api}/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        setIsPending(false)
        const errorText = await response.text()
        throw new Error(errorText || `HTTP ${response.status}`)
      }

      const data = (await response.json()) as {
        runId: string
        status?: RunStatus
      }
      setCurrentRunId(data.runId)
      if (data.status) {
        setHydratedStatus(data.status)
      }

      return { runId: data.runId }
    },
    [api, jobName, stableTriggerOptions, subscription.reset],
  )

  const triggerAndWait = useCallback(
    async (input: TInput): Promise<{ runId: string; output: TOutput }> => {
      const { runId } = await trigger(input)

      return new Promise((resolve, reject) => {
        const subscriber = createSSEEventSubscriber(api)
        let unsubscribe = () => {}
        const settle = (callback: () => void) => {
          unsubscribe()
          waitUnsubscribesRef.current.delete(unsubscribe)
          callback()
        }
        unsubscribe = subscriber.subscribe<TOutput>(runId, (event) => {
          if (event.type === 'run:complete') {
            settle(() => resolve({ runId, output: event.output }))
          } else if (event.type === 'run:fail') {
            settle(() => reject(new Error(event.error ?? 'Job failed')))
          } else if (event.type === 'run:cancel') {
            settle(() => reject(new Error('Job cancelled')))
          } else if (event.type === 'connection_error') {
            settle(() => reject(new Error(event.error)))
          }
        })
        waitUnsubscribesRef.current.add(unsubscribe)
      })
    },
    [api, trigger],
  )

  // Clean up run-specific waits on unmount
  useEffect(() => {
    return () => {
      for (const unsubscribe of waitUnsubscribesRef.current) {
        unsubscribe()
      }
      waitUnsubscribesRef.current.clear()
    }
  }, [])

  const reset = useCallback(() => {
    subscription.reset()
    setCurrentRunId(null)
    setHydratedStatus(null)
    setIsPending(false)
  }, [subscription.reset])

  // Compute effective status
  const effectiveStatus =
    subscription.status ?? hydratedStatus ?? (isPending ? 'pending' : null)

  // Clear pending/hydrated when we get a real status from SSE
  useEffect(() => {
    if (subscription.status) {
      if (isPending) setIsPending(false)
      if (hydratedStatus) setHydratedStatus(null)
    }
  }, [subscription.status, isPending, hydratedStatus])

  return {
    trigger,
    triggerAndWait,
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
    isTerminal:
      effectiveStatus === 'completed' ||
      effectiveStatus === 'failed' ||
      effectiveStatus === 'cancelled',
    isActive: effectiveStatus === 'pending' || effectiveStatus === 'leased',
    isResolving,
    currentRunId,
    reset,
  }
}
