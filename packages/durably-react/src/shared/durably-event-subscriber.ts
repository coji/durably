import type { Durably } from '@coji/durably'
import type { EventSubscriber, SubscriptionEvent } from './event-subscriber'

/**
 * EventSubscriber implementation using Durably.on() for direct subscriptions.
 * Used in browser environments where Durably instance is available.
 */
export function createDurablyEventSubscriber(
  durably: Durably,
): EventSubscriber {
  return {
    subscribe<TOutput = unknown>(
      runId: string,
      onEvent: (event: SubscriptionEvent<TOutput>) => void,
    ): () => void {
      const unsubscribes: (() => void)[] = []

      unsubscribes.push(
        durably.on('run:start', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:start' })
        }),
      )

      unsubscribes.push(
        durably.on('run:complete', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:complete', output: event.output as TOutput })
        }),
      )

      unsubscribes.push(
        durably.on('run:fail', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:fail', error: event.error })
        }),
      )

      unsubscribes.push(
        durably.on('run:cancel', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:cancel' })
        }),
      )

      unsubscribes.push(
        durably.on('run:retry', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:retry' })
        }),
      )

      unsubscribes.push(
        durably.on('run:progress', (event) => {
          if (event.runId !== runId) return
          onEvent({ type: 'run:progress', progress: event.progress })
        }),
      )

      unsubscribes.push(
        durably.on('log:write', (event) => {
          if (event.runId !== runId) return
          onEvent({
            type: 'log:write',
            runId: event.runId,
            stepName: event.stepName,
            level: event.level,
            message: event.message,
            data: event.data,
          })
        }),
      )

      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe()
        }
      }
    },
  }
}
