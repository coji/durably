import type { Durably } from '@coji/durably'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  initialSubscriptionState,
  subscriptionReducer,
  type SubscriptionAction,
} from '../shared/subscription-reducer'
import type { RunStatus, SubscriptionState } from '../types'

function matchesLabels(
  eventLabels?: Record<string, string>,
  scopeLabels?: Record<string, string>,
): boolean {
  if (!scopeLabels) return true
  if (!eventLabels) return false
  for (const [key, value] of Object.entries(scopeLabels)) {
    if (eventLabels[key] !== value) return false
  }
  return true
}

export interface UseJobSubscriptionOptions {
  /**
   * Automatically switch to tracking the latest running job when a new run starts.
   * @default true
   */
  followLatest?: boolean
  /**
   * Maximum number of logs to keep (0 = unlimited)
   */
  maxLogs?: number
  /**
   * Optional scope to filter events by labels
   */
  scope?: { labels: Record<string, string> }
  /**
   * Callback when followLatest switches to a new run
   */
  onFollow?: (runId: string) => void
}

export interface UseJobSubscriptionResult<
  TOutput = unknown,
> extends SubscriptionState<TOutput> {
  /**
   * Current run ID being tracked
   */
  currentRunId: string | null
  /**
   * Set the current run ID to track
   */
  setCurrentRunId: (runId: string | null) => void
  /**
   * Hydrate full run state immediately
   */
  hydrateRun: (
    runId: string,
    status: RunStatus,
    output?: TOutput | null,
    error?: string | null,
  ) => void
  /**
   * Apply a re-read run state only while that same run is still active.
   */
  revalidateRun: (
    runId: string,
    expectedStatus: RunStatus,
    status: RunStatus,
    output?: TOutput | null,
    error?: string | null,
  ) => void
  /**
   * Clear all logs
   */
  clearLogs: () => void
  /**
   * Reset all state including currentRunId
   */
  reset: () => void
}

// Extended state for job subscription (includes currentRunId)
interface JobSubscriptionState<
  TOutput = unknown,
> extends SubscriptionState<TOutput> {
  currentRunId: string | null
}

// Extended actions for job subscription
type JobSubscriptionAction<TOutput = unknown> =
  | SubscriptionAction<TOutput>
  | { type: 'set_run_id'; runId: string | null }
  | {
      type: 'switch_to_run'
      runId: string
      status?: RunStatus
    }
  | {
      type: 'hydrate_run'
      runId: string
      status: RunStatus
      output?: TOutput | null
      error?: string | null
    }
  | {
      type: 'revalidate_run'
      runId: string
      expectedStatus: RunStatus
      status: RunStatus
      output?: TOutput | null
      error?: string | null
    }

function jobSubscriptionReducer<TOutput = unknown>(
  state: JobSubscriptionState<TOutput>,
  action: JobSubscriptionAction<TOutput>,
): JobSubscriptionState<TOutput> {
  switch (action.type) {
    case 'set_run_id':
      return { ...state, currentRunId: action.runId }

    case 'set_active_status':
      return { ...state, status: action.status }

    case 'switch_to_run':
      // Switch to a new run, resetting state
      return {
        ...initialSubscriptionState,
        currentRunId: action.runId,
        status: action.status ?? 'leased',
      } as JobSubscriptionState<TOutput>

    case 'hydrate_run':
      return {
        ...initialSubscriptionState,
        currentRunId: action.runId,
        status: action.status,
        output: action.output ?? null,
        error: action.error ?? null,
      } as JobSubscriptionState<TOutput>

    case 'revalidate_run':
      if (
        state.currentRunId !== action.runId ||
        state.status !== action.expectedStatus
      ) {
        return state
      }
      return {
        ...state,
        status: action.status,
        output: action.output ?? null,
        error: action.error ?? null,
      }

    case 'reset':
      return {
        ...(initialSubscriptionState as SubscriptionState<TOutput>),
        currentRunId: null,
      }

    default:
      // Delegate to base subscription reducer
      return {
        ...subscriptionReducer(state, action as SubscriptionAction<TOutput>),
        currentRunId: state.currentRunId,
      }
  }
}

/**
 * Hook for subscribing to job events with followLatest support.
 * This is a specialized version of useSubscription for job-level tracking.
 */
export function useJobSubscription<TOutput = unknown>(
  durably: Durably | null,
  jobName: string,
  options?: UseJobSubscriptionOptions,
): UseJobSubscriptionResult<TOutput> {
  const initialState: JobSubscriptionState<TOutput> = {
    ...(initialSubscriptionState as SubscriptionState<TOutput>),
    currentRunId: null,
  }

  const [state, dispatch] = useReducer(
    jobSubscriptionReducer<TOutput>,
    initialState,
  )

  const currentRunIdRef = useRef<string | null>(null)
  currentRunIdRef.current = state.currentRunId

  const followLatest = options?.followLatest !== false
  const maxLogs = options?.maxLogs ?? 0
  const scopeLabels = options?.scope?.labels
  const onFollow = options?.onFollow

  useEffect(() => {
    if (!durably) return

    const unsubscribes: (() => void)[] = []

    unsubscribes.push(
      durably.on('run:trigger', (event) => {
        if (event.jobName !== jobName) return
        if (!matchesLabels(event.labels, scopeLabels)) return

        if (followLatest) {
          dispatch({
            type: 'switch_to_run',
            runId: event.runId,
            status: 'pending',
          })
          currentRunIdRef.current = event.runId
          onFollow?.(event.runId)
        }
      }),
    )

    unsubscribes.push(
      durably.on('run:leased', (event) => {
        if (event.jobName !== jobName) return
        if (event.runId === currentRunIdRef.current) {
          dispatch({ type: 'set_active_status', status: 'leased' })
          return
        }

        if (followLatest) {
          if (!matchesLabels(event.labels, scopeLabels)) return
          // Switch to tracking the new run
          dispatch({
            type: 'switch_to_run',
            runId: event.runId,
            status: 'leased',
          })
          currentRunIdRef.current = event.runId
          onFollow?.(event.runId)
        }
      }),
    )

    // Coalesced triggers skip run:trigger, so followLatest must react here
    unsubscribes.push(
      durably.on('run:coalesced', (event) => {
        if (event.jobName !== jobName) return
        if (event.runId === currentRunIdRef.current) {
          dispatch({ type: 'set_active_status', status: event.status })
          return
        }
        if (!matchesLabels(event.labels, scopeLabels)) return

        if (followLatest) {
          dispatch({
            type: 'switch_to_run',
            runId: event.runId,
            status: event.status,
          })
          currentRunIdRef.current = event.runId
          onFollow?.(event.runId)
        }
      }),
    )

    unsubscribes.push(
      durably.on('run:complete', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({ type: 'run:complete', output: event.output as TOutput })
      }),
    )

    unsubscribes.push(
      durably.on('run:fail', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({ type: 'run:fail', error: event.error })
      }),
    )

    unsubscribes.push(
      durably.on('run:cancel', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({ type: 'run:cancel' })
      }),
    )

    unsubscribes.push(
      durably.on('run:progress', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({ type: 'run:progress', progress: event.progress })
      }),
    )

    unsubscribes.push(
      durably.on('log:write', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({
          type: 'log:write',
          runId: event.runId,
          stepName: event.stepName,
          level: event.level,
          message: event.message,
          data: event.data,
          maxLogs,
        })
      }),
    )

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [durably, jobName, followLatest, maxLogs, scopeLabels, onFollow])

  const setCurrentRunId = useCallback((runId: string | null) => {
    dispatch({ type: 'set_run_id', runId })
    currentRunIdRef.current = runId
  }, [])

  const hydrateRun = useCallback(
    (
      runId: string,
      status: RunStatus,
      output?: TOutput | null,
      error?: string | null,
    ) => {
      dispatch({ type: 'hydrate_run', runId, status, output, error })
      currentRunIdRef.current = runId
    },
    [],
  )

  const revalidateRun = useCallback(
    (
      runId: string,
      expectedStatus: RunStatus,
      status: RunStatus,
      output?: TOutput | null,
      error?: string | null,
    ) => {
      dispatch({
        type: 'revalidate_run',
        runId,
        expectedStatus,
        status,
        output,
        error,
      })
    },
    [],
  )

  const clearLogs = useCallback(() => {
    dispatch({ type: 'clear_logs' })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
    currentRunIdRef.current = null
  }, [])

  return {
    ...state,
    setCurrentRunId,
    hydrateRun,
    revalidateRun,
    clearLogs,
    reset,
  }
}
