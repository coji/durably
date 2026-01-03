import { useMemo } from 'react'
import { createSSEEventSubscriber } from '../shared/sse-event-subscriber'
import {
  useSubscription,
  type UseSubscriptionOptions,
  type UseSubscriptionResult,
} from '../shared/use-subscription'
import type { SubscriptionState } from '../types'

/** @deprecated Use SubscriptionState from '../types' instead */
export type SSESubscriptionState<TOutput = unknown> = SubscriptionState<TOutput>

/** @deprecated Use UseSubscriptionOptions from '../shared/use-subscription' instead */
export type UseSSESubscriptionOptions = UseSubscriptionOptions

/** @deprecated Use UseSubscriptionResult from '../shared/use-subscription' instead */
export type UseSSESubscriptionResult<TOutput = unknown> =
  UseSubscriptionResult<TOutput>

/**
 * Internal hook for subscribing to run events via SSE.
 * Used by client-mode hooks (useJob, useJobRun, useJobLogs).
 *
 * @deprecated Consider using useSubscription with createSSEEventSubscriber directly.
 */
export function useSSESubscription<TOutput = unknown>(
  api: string | null,
  runId: string | null,
  options?: UseSSESubscriptionOptions,
): UseSSESubscriptionResult<TOutput> {
  const subscriber = useMemo(
    () => (api ? createSSEEventSubscriber(api) : null),
    [api],
  )

  return useSubscription<TOutput>(subscriber, runId, options)
}
