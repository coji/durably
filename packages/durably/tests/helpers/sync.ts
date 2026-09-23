/**
 * Synchronization helpers for tests.
 *
 * Tests order concurrent work with these instead of sleeping. A sleep only
 * guesses how long something takes, and a loaded CI runner eventually makes
 * the guess wrong. `scripts/check-test-sleeps.mjs` rejects an unexplained
 * `setTimeout` in a test file.
 */
import type { Durably } from '../../src'

export interface Deferred<T = void> {
  promise: Promise<T>
  resolve: (value: T) => void
}

/** A promise the test settles by hand: a gate to hold work, or a signal. */
export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

/**
 * End a run's current lease as if its owner had stalled past `leaseMs`.
 *
 * Use a long `leaseMs` and call this at the point the test wants the lease
 * gone. Sleeping past a tiny lease races the clock both ways: the lease can
 * expire before the owner reaches the code under test, or not yet have
 * expired when the reclaimer looks. The owner's next renewal fails, as it
 * would after a real expiry.
 */
export async function expireLease(
  durably: Durably<any, any>,
  runId: string,
): Promise<void> {
  await durably.db
    .updateTable('durably_runs')
    .set({ lease_expires_at: new Date(0).toISOString() })
    .where('id', '=', runId)
    .where('status', '=', 'leased')
    .execute()
}

/**
 * Control the storage reads a waiter makes. Deleting a run means completing
 * it first, and a poll that reads between completion and deletion would
 * legitimately resolve with the completed run. `pause` holds new reads and
 * waits for any read already in flight, so the next read the waiter makes
 * happens after `restore` and sees the deletion.
 */
export function controlRunReads(durably: Durably<any, any>) {
  const original = durably.storage.getRun
  const inFlight = new Set<Promise<unknown>>()
  let held: Promise<void> | null = null
  let release = () => {}
  durably.storage.getRun = (async (...args: Parameters<typeof original>) => {
    if (held) await held
    const read = original(...args)
    inFlight.add(read)
    try {
      return await read
    } finally {
      inFlight.delete(read)
    }
  }) as typeof original
  return {
    async pause() {
      held = new Promise<void>((resolve) => {
        release = resolve
      })
      await Promise.allSettled(inFlight)
    },
    restore() {
      release()
      held = null
      durably.storage.getRun = original
    },
  }
}

/**
 * Resolve once `signal` aborts, including when it already has. Use it for a
 * step that should run until cancellation or lease loss ends it.
 */
export function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}
