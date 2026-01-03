import type { Progress } from '../types'

/**
 * Common event types emitted by both Durably.on and SSE subscriptions.
 * This abstraction allows hooks to work with either event source.
 */
export type SubscriptionEvent<TOutput = unknown> =
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
    }
  | { type: 'connection_error'; error: string }

/**
 * Common interface for subscribing to run events.
 * Implemented by both DurablyEventSubscriber and SSEEventSubscriber.
 */
export interface EventSubscriber {
  /**
   * Subscribe to events for a specific run.
   * @param runId The run ID to subscribe to
   * @param onEvent Callback for each event
   * @returns Cleanup function to unsubscribe
   */
  subscribe<TOutput = unknown>(
    runId: string,
    onEvent: (event: SubscriptionEvent<TOutput>) => void,
  ): () => void
}
