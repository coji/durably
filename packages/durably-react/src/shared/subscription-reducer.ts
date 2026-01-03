import type { Progress, SubscriptionState } from '../types'
import { appendLog, createLogEntry } from './create-log-entry'

// Action types for subscription state transitions
export type SubscriptionAction<TOutput = unknown> =
  | { type: 'run:start' }
  | { type: 'run:complete'; output: TOutput }
  | { type: 'run:fail'; error: string }
  | { type: 'run:cancel' }
  | { type: 'run:retry' }
  | { type: 'run:progress'; progress: Progress }
  | {
      type: 'log:write'
      runId: string
      stepName: string | null
      level: 'info' | 'warn' | 'error'
      message: string
      data: unknown
      maxLogs: number
    }
  | { type: 'reset' }
  | { type: 'clear_logs' }
  | { type: 'connection_error'; error: string }

export const initialSubscriptionState: SubscriptionState<unknown> = {
  status: null,
  output: null,
  error: null,
  logs: [],
  progress: null,
}

/**
 * Pure reducer for subscription state transitions.
 * Extracted to eliminate duplication between useRunSubscription and useSSESubscription.
 */
export function subscriptionReducer<TOutput = unknown>(
  state: SubscriptionState<TOutput>,
  action: SubscriptionAction<TOutput>,
): SubscriptionState<TOutput> {
  switch (action.type) {
    case 'run:start':
      return { ...state, status: 'running' }

    case 'run:complete':
      return { ...state, status: 'completed', output: action.output }

    case 'run:fail':
      return { ...state, status: 'failed', error: action.error }

    case 'run:cancel':
      return { ...state, status: 'cancelled' }

    case 'run:retry':
      return { ...state, status: 'pending', error: null }

    case 'run:progress':
      return { ...state, progress: action.progress }

    case 'log:write': {
      const newLog = createLogEntry({
        runId: action.runId,
        stepName: action.stepName,
        level: action.level,
        message: action.message,
        data: action.data,
      })
      return { ...state, logs: appendLog(state.logs, newLog, action.maxLogs) }
    }

    case 'reset':
      return initialSubscriptionState as SubscriptionState<TOutput>

    case 'clear_logs':
      return { ...state, logs: [] }

    case 'connection_error':
      return { ...state, error: action.error }

    default:
      return state
  }
}
