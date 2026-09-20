import type { TriggerOptions } from '@coji/durably'
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
} from 'react'
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
  // A response may settle after a new commit but before passive effects run.
  // Publish only committed contexts, before descendant layout effects can trigger.
  const trackingContextRef = useRef({
    api,
    jobName,
    initialRunId,
    scope: stableScope,
    currentRunId,
  })
  const resolutionEpochRef = useRef(0)
  const followedEpochRef = useRef<number | null>(null)
  const hasUserTriggered = useRef(false)
  useInsertionEffect(() => {
    const previous = trackingContextRef.current
    if (
      previous.api !== api ||
      previous.jobName !== jobName ||
      previous.initialRunId !== initialRunId ||
      previous.scope !== stableScope
    ) {
      // Invalidate the old context before a consumer layout effect can trigger
      // a run in the newly committed context.
      resolutionEpochRef.current++
      hasUserTriggered.current = false
    }
    trackingContextRef.current = {
      api,
      jobName,
      initialRunId,
      scope: stableScope,
      currentRunId,
    }
  })
  const [isPending, setIsPending] = useState(false)
  const [hydratedStatus, setHydratedStatus] = useState<RunStatus | null>(null)

  const prevScopeRef = useRef(stableScope)
  const prevSourceRef = useRef({ api, jobName })
  const prevInitialRunIdRef = useRef(initialRunId)
  const [isResolving, setIsResolving] = useState(autoResume && !initialRunId)
  const [autoResumeRestart, setAutoResumeRestart] = useState(0)

  // Track if user has triggered a run (to prevent autoResume from overwriting)
  const waitUnsubscribesRef = useRef(new Set<() => void>())

  const subscription = useSSESubscription<TOutput>(api, currentRunId)

  // Handle scope changes
  useEffect(() => {
    if (prevScopeRef.current !== stableScope) {
      prevScopeRef.current = stableScope
      if (hasUserTriggered.current) {
        if (initialRunId && currentRunId === initialRunId) return
        subscription.reset()
        setCurrentRunId(initialRunId ?? null)
        setHydratedStatus(null)
        setIsResolving(false)
        return
      }
      if (initialRunId && currentRunId === initialRunId) {
        setIsPending(false)
        setIsResolving(false)
        return
      }
      subscription.reset()
      setCurrentRunId(initialRunId ?? null)
      setHydratedStatus(null)
      setIsPending(false)
      setIsResolving(autoResume && !initialRunId)
    }
  }, [stableScope, initialRunId, currentRunId, autoResume, subscription.reset])

  // A changed endpoint or job is a new tracking context, even with the same scope.
  useEffect(() => {
    if (
      prevSourceRef.current.api === api &&
      prevSourceRef.current.jobName === jobName
    )
      return
    prevSourceRef.current = { api, jobName }
    if (hasUserTriggered.current) {
      subscription.reset()
      setCurrentRunId(initialRunId ?? null)
      setHydratedStatus(null)
      setIsResolving(false)
      return
    }
    subscription.reset()
    setCurrentRunId(initialRunId ?? null)
    setHydratedStatus(null)
    setIsPending(false)
    setIsResolving(autoResume && !initialRunId)
  }, [api, jobName, initialRunId, autoResume, subscription.reset])

  // Handle initialRunId updates
  useEffect(() => {
    const previous = prevInitialRunIdRef.current
    if (previous === initialRunId) return
    prevInitialRunIdRef.current = initialRunId
    if (hasUserTriggered.current) {
      subscription.reset()
      setCurrentRunId(initialRunId ?? null)
      setHydratedStatus(null)
      setIsResolving(false)
      return
    }
    if (!initialRunId) {
      if (previous) {
        subscription.reset()
        setCurrentRunId(null)
        setHydratedStatus(null)
        setIsPending(false)
      }
      return
    }
    setIsResolving(false)
    setHydratedStatus(null)
    setIsPending(false)
    setCurrentRunId(initialRunId)
  }, [initialRunId, subscription.reset])

  // Auto-resume: fetch leased/pending job on mount / scope change
  useEffect(() => {
    // A failed trigger retries this lookup for the current scope.
    void autoResumeRestart
    if (!autoResume) {
      setIsResolving(false)
      return
    }
    if (initialRunId) {
      setIsResolving(false)
      return // Skip if initialRunId is provided
    }
    if (hasUserTriggered.current) {
      setIsResolving(false)
      return
    }
    if (followedEpochRef.current === resolutionEpochRef.current) {
      setIsResolving(false)
      return
    }

    setIsResolving(true)

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

      // Resolve the preferred leased run first. A failed or slow pending
      // lookup must not hide a leased run that is already available.
      let leasedRes: Response | null = null
      try {
        leasedRes = await fetch(`${api}/runs?${leasedParams}`, { signal })
      } catch (err) {
        if (signal.aborted) throw err
      }

      if (
        cancelled ||
        hasUserTriggered.current ||
        resolutionEpochRef.current !== epoch
      ) {
        return
      }

      // Prefer leased over pending
      if (leasedRes?.ok) {
        const runs = (await leasedRes.json()) as Array<{
          id: string
          status?: RunStatus
        }>
        if (
          cancelled ||
          hasUserTriggered.current ||
          resolutionEpochRef.current !== epoch
        )
          return
        if (runs.length > 0) {
          setCurrentRunId(runs[0].id)
          setHydratedStatus(runs[0].status ?? 'leased')
          setIsResolving(false)
          return
        }
      }

      const pendingRes = await fetch(`${api}/runs?${pendingParams}`, { signal })
      if (
        cancelled ||
        hasUserTriggered.current ||
        resolutionEpochRef.current !== epoch
      ) {
        return
      }
      if (pendingRes.ok) {
        const runs = (await pendingRes.json()) as Array<{
          id: string
          status?: RunStatus
        }>
        if (
          cancelled ||
          hasUserTriggered.current ||
          resolutionEpochRef.current !== epoch
        )
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
  }, [api, jobName, autoResume, initialRunId, stableScope, autoResumeRestart])

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
      const context = trackingContextRef.current
      if (
        context.api !== api ||
        context.jobName !== jobName ||
        context.scope !== stableScope
      ) {
        return
      }
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
          followedEpochRef.current = ++resolutionEpochRef.current
          setIsResolving(false)
          setCurrentRunId(data.runId)
          if (data.type === 'run:trigger') {
            setHydratedStatus('pending')
          } else if (data.type === 'run:leased') {
            setHydratedStatus('leased')
          } else if (data.type === 'run:coalesced' && data.status) {
            setHydratedStatus(data.status)
            if (data.status === 'pending' || data.status === 'leased') {
              subscription.setActiveStatus(data.status)
            }
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
  }, [api, jobName, followLatest, stableScope, subscription.setActiveStatus])

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      if (
        trackingContextRef.current.api !== api ||
        trackingContextRef.current.jobName !== jobName
      ) {
        throw new Error('Job source changed')
      }
      hasUserTriggered.current = true
      const epoch = ++resolutionEpochRef.current
      setIsResolving(false)
      const triggerContext = { ...trackingContextRef.current, api, jobName }
      const preserveFixedRun =
        !!triggerContext.initialRunId &&
        triggerContext.currentRunId === triggerContext.initialRunId
      const isCurrent = () => {
        const current = trackingContextRef.current
        return (
          resolutionEpochRef.current === epoch &&
          current.api === triggerContext.api &&
          current.jobName === triggerContext.jobName &&
          current.initialRunId === triggerContext.initialRunId &&
          current.scope === triggerContext.scope
        )
      }

      // Keep the fixed run visible until a new trigger result is accepted.
      // A scope change can supersede the request before it returns.
      if (!preserveFixedRun) {
        subscription.reset()
        setHydratedStatus(null)
      }
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

      let data: { runId: string; status?: RunStatus }
      try {
        const response = await fetch(`${api}/trigger`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(errorText || `HTTP ${response.status}`)
        }

        data = (await response.json()) as {
          runId: string
          status?: RunStatus
        }
      } catch (error) {
        if (isCurrent()) {
          hasUserTriggered.current = false
          setIsPending(false)
          setAutoResumeRestart((value) => value + 1)
        }
        throw error
      }
      if (isCurrent()) {
        if (preserveFixedRun) {
          subscription.reset()
          setHydratedStatus(null)
          setIsPending(!data.status)
        }
        setCurrentRunId(data.runId)
        if (data.status) {
          setHydratedStatus(data.status)
        }
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
    resolutionEpochRef.current++
    setIsResolving(false)
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
