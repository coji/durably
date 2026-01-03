import type { Durably } from '@coji/durably'
import { useMemo } from 'react'
import { createDurablyEventSubscriber } from '../shared/durably-event-subscriber'
import {
  useSubscription,
  type UseSubscriptionOptions,
  type UseSubscriptionResult,
} from '../shared/use-subscription'
import type { SubscriptionState } from '../types'

/** @deprecated Use SubscriptionState from '../types' instead */
export type RunSubscriptionState<TOutput = unknown> = SubscriptionState<TOutput>

/** @deprecated Use UseSubscriptionOptions from '../shared/use-subscription' instead */
export type UseRunSubscriptionOptions = UseSubscriptionOptions

/** @deprecated Use UseSubscriptionResult from '../shared/use-subscription' instead */
export type UseRunSubscriptionResult<TOutput = unknown> =
  UseSubscriptionResult<TOutput>

/**
 * Internal hook for subscribing to run events via Durably.on().
 * Shared by useJob, useJobRun, and useJobLogs.
 *
 * @deprecated Consider using useSubscription with createDurablyEventSubscriber directly.
 */
export function useRunSubscription<TOutput = unknown>(
  durably: Durably | null,
  runId: string | null,
  options?: UseRunSubscriptionOptions,
): UseRunSubscriptionResult<TOutput> {
  const subscriber = useMemo(
    () => (durably ? createDurablyEventSubscriber(durably) : null),
    [durably],
  )

  return useSubscription<TOutput>(subscriber, runId, options)
}
