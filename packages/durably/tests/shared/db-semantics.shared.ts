import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'

export function createDbSemanticsTests(
  label: string,
  createDialect:
    | (() => Dialect)
    | {
        createDialect(): Dialect
        setup?(): Promise<void> | void
        cleanup?(): Promise<void> | void
      },
) {
  describe(`${label} queue semantics`, () => {
    let durably: Durably
    const resource =
      typeof createDialect === 'function' ? { createDialect } : createDialect

    beforeEach(async () => {
      await resource.setup?.()
      durably = createDurably({ dialect: resource.createDialect() })
      await durably.migrate()
      await durably.db.deleteFrom('durably_logs').execute()
      await durably.db.deleteFrom('durably_steps').execute()
      await durably.db.deleteFrom('durably_runs').execute()
    })

    afterEach(async () => {
      if (durably) {
        await durably.db.destroy()
      }
      await resource.cleanup?.()
    })

    it('enforces idempotent enqueue at storage level', async () => {
      const first = await durably.storage.enqueue({
        jobName: 'job',
        input: { n: 1 },
        idempotencyKey: 'same-key',
      })

      const second = await durably.storage.enqueue({
        jobName: 'job',
        input: { n: 2 },
        idempotencyKey: 'same-key',
      })

      expect(second.id).toBe(first.id)
      expect(second.input).toEqual({ n: 1 })
    })

    it('allows only one claimant to win the same run', async () => {
      await durably.storage.enqueue({
        jobName: 'job',
        input: { value: 1 },
      })

      const now = new Date().toISOString()
      const [first, second] = await Promise.all([
        durably.storage.claimNext('worker-a', now, 30_000),
        durably.storage.claimNext('worker-b', now, 30_000),
      ])

      const winners = [first, second].filter((run) => run !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.status).toBe('leased')
    })

    it('rejects lease renewal with wrong generation', async () => {
      const created = await durably.storage.enqueue({
        jobName: 'job',
        input: {},
      })
      const now = new Date().toISOString()
      const claimed = await durably.storage.claimNext('worker-a', now, 30_000)

      expect(claimed?.id).toBe(created.id)
      const gen = claimed!.leaseGeneration

      // Wrong generation should be rejected
      const renewed = await durably.storage.renewLease(
        created.id,
        gen + 1,
        new Date().toISOString(),
        30_000,
      )

      expect(renewed).toBe(false)
    })

    it('rejects completion from a stale owner after reclaim', async () => {
      const created = await durably.storage.enqueue({
        jobName: 'job',
        input: {},
      })

      // First claim
      const firstClaim = await durably.storage.claimNext(
        'worker-a',
        new Date().toISOString(),
        30_000,
      )
      expect(firstClaim?.id).toBe(created.id)
      const firstGen = firstClaim!.leaseGeneration

      // Expire lease so it can be reclaimed
      await durably.storage.updateRun(created.id, {
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const reclaimed = await durably.storage.claimNext(
        'worker-b',
        new Date().toISOString(),
        30_000,
      )

      expect(reclaimed?.id).toBe(created.id)
      expect(reclaimed?.leaseOwner).toBe('worker-b')
      const secondGen = reclaimed!.leaseGeneration

      // Stale worker tries with old generation — rejected
      const staleCompletion = await durably.storage.completeRun(
        created.id,
        firstGen,
        { ok: false },
        new Date().toISOString(),
      )

      expect(staleCompletion).toBe(false)

      // Current owner completes with correct generation — succeeds
      const winningCompletion = await durably.storage.completeRun(
        created.id,
        secondGen,
        { ok: true },
        new Date().toISOString(),
      )

      expect(winningCompletion).toBe(true)
    })

    it('reclaims an expired leased run and preserves startedAt', async () => {
      const created = await durably.storage.enqueue({
        jobName: 'job',
        input: {},
      })
      const firstClaim = await durably.storage.claimNext(
        'worker-a',
        new Date().toISOString(),
        30_000,
      )

      expect(firstClaim?.id).toBe(created.id)
      const originalStartedAt = firstClaim?.startedAt
      expect(originalStartedAt).toBeTruthy()

      await durably.storage.updateRun(created.id, {
        status: 'leased',
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const reclaimed = await durably.storage.claimNext(
        'worker-b',
        new Date().toISOString(),
        30_000,
      )

      expect(reclaimed?.id).toBe(created.id)
      expect(reclaimed?.status).toBe('leased')
      expect(reclaimed?.leaseOwner).toBe('worker-b')
      expect(reclaimed?.startedAt).toBe(originalStartedAt)
    })
  })
}
