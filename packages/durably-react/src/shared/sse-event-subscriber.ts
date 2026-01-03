import type { DurablyEvent } from '../types'
import type { EventSubscriber, SubscriptionEvent } from './event-subscriber'

/**
 * EventSubscriber implementation using Server-Sent Events (SSE).
 * Used in client environments that communicate with a Durably server via HTTP.
 */
export function createSSEEventSubscriber(apiBaseUrl: string): EventSubscriber {
  return {
    subscribe<TOutput = unknown>(
      runId: string,
      onEvent: (event: SubscriptionEvent<TOutput>) => void,
    ): () => void {
      const url = `${apiBaseUrl}/subscribe?runId=${encodeURIComponent(runId)}`
      const eventSource = new EventSource(url)

      eventSource.onmessage = (messageEvent) => {
        try {
          const data = JSON.parse(messageEvent.data) as DurablyEvent
          if (data.runId !== runId) return

          switch (data.type) {
            case 'run:start':
              onEvent({ type: 'run:start' })
              break
            case 'run:complete':
              onEvent({
                type: 'run:complete',
                output: data.output as TOutput,
              })
              break
            case 'run:fail':
              onEvent({ type: 'run:fail', error: data.error })
              break
            case 'run:cancel':
              onEvent({ type: 'run:cancel' })
              break
            case 'run:retry':
              onEvent({ type: 'run:retry' })
              break
            case 'run:progress':
              onEvent({ type: 'run:progress', progress: data.progress })
              break
            case 'log:write':
              onEvent({
                type: 'log:write',
                runId: data.runId,
                stepName: null,
                level: data.level,
                message: data.message,
                data: data.data,
              })
              break
          }
        } catch {
          // Ignore parse errors
        }
      }

      eventSource.onerror = () => {
        onEvent({ type: 'connection_error', error: 'Connection failed' })
        eventSource.close()
      }

      return () => {
        eventSource.close()
      }
    },
  }
}
