import type { Durably } from '@coji/durably'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  initialSubscriptionState,
  subscriptionReducer,
  type SubscriptionAction,
} from '../shared/subscription-reducer'
import type { SubscriptionState } from '../types'

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
    }

function jobSubscriptionReducer<TOutput = unknown>(
  state: JobSubscriptionState<TOutput>,
  action: JobSubscriptionAction<TOutput>,
): JobSubscriptionState<TOutput> {
  switch (action.type) {
    case 'set_run_id':
      return { ...state, currentRunId: action.runId }

    case 'switch_to_run':
      // Switch to a new run, resetting state
      return {
        ...initialSubscriptionState,
        currentRunId: action.runId,
        status: 'running',
      } as JobSubscriptionState<TOutput>

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

  useEffect(() => {
    if (!durably) return

    const unsubscribes: (() => void)[] = []

    unsubscribes.push(
      durably.on('run:start', (event) => {
        if (event.jobName !== jobName) return

        if (followLatest) {
          // Switch to tracking the new run
          dispatch({ type: 'switch_to_run', runId: event.runId })
          currentRunIdRef.current = event.runId
        } else {
          // Only update if this is our current run
          if (event.runId !== currentRunIdRef.current) return
          dispatch({ type: 'run:start' })
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
      durably.on('run:retry', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        dispatch({ type: 'run:retry' })
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
  }, [durably, jobName, followLatest, maxLogs])

  const setCurrentRunId = useCallback((runId: string | null) => {
    dispatch({ type: 'set_run_id', runId })
    currentRunIdRef.current = runId
  }, [])

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
    clearLogs,
    reset,
  }
}
