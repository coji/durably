import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { SubscriptionState } from '../types'
import type { EventSubscriber } from './event-subscriber'
import {
  initialSubscriptionState,
  subscriptionReducer,
} from './subscription-reducer'

export interface UseSubscriptionOptions {
  /**
   * Maximum number of logs to keep (0 = unlimited)
   */
  maxLogs?: number
}

export interface UseSubscriptionResult<
  TOutput = unknown,
> extends SubscriptionState<TOutput> {
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
 * Core subscription hook that works with any EventSubscriber implementation.
 * This unifies the subscription logic between Durably.on and SSE.
 */
export function useSubscription<TOutput = unknown>(
  subscriber: EventSubscriber | null,
  runId: string | null,
  options?: UseSubscriptionOptions,
): UseSubscriptionResult<TOutput> {
  const [state, dispatch] = useReducer(
    subscriptionReducer<TOutput>,
    initialSubscriptionState as SubscriptionState<TOutput>,
  )

  const runIdRef = useRef<string | null>(runId)
  const prevRunIdRef = useRef<string | null>(null)

  const maxLogs = options?.maxLogs ?? 0

  // Reset state when runId changes
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId
    if (runIdRef.current !== runId) {
      dispatch({ type: 'reset' })
    }
  }
  runIdRef.current = runId

  useEffect(() => {
    if (!subscriber || !runId) return

    const unsubscribe = subscriber.subscribe<TOutput>(runId, (event) => {
      // Verify runId hasn't changed during async operation
      if (runIdRef.current !== runId) return

      switch (event.type) {
        case 'run:start':
        case 'run:cancel':
        case 'run:retry':
          dispatch({ type: event.type })
          break
        case 'run:complete':
          dispatch({ type: 'run:complete', output: event.output })
          break
        case 'run:fail':
          dispatch({ type: 'run:fail', error: event.error })
          break
        case 'run:progress':
          dispatch({ type: 'run:progress', progress: event.progress })
          break
        case 'log:write':
          dispatch({
            type: 'log:write',
            runId: event.runId,
            stepName: event.stepName,
            level: event.level,
            message: event.message,
            data: event.data,
            maxLogs,
          })
          break
        case 'connection_error':
          dispatch({ type: 'connection_error', error: event.error })
          break
      }
    })

    return unsubscribe
  }, [subscriber, runId, maxLogs])

  const clearLogs = useCallback(() => {
    dispatch({ type: 'clear_logs' })
  }, [])

  const reset = useCallback(() => {
    dispatch({ type: 'reset' })
  }, [])

  return {
    ...state,
    clearLogs,
    reset,
  }
}
