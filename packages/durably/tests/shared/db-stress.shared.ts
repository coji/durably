import type { Dialect } from 'kysely'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'

interface SharedDialectResource {
  createDialect(): Dialect
  setup?(): Promise<void> | void
  cleanup?(): Promise<void> | void
}

export function createDbStressTests(
  label: string,
  createResource: () => SharedDialectResource,
) {
  describe(`${label} queue stress`, () => {
    let resource: SharedDialectResource
    let runtimes: Array<Durably<any, any>> = []

    beforeEach(async () => {
      resource = createResource()
      await resource.setup?.()
      runtimes = Array.from({ length: 4 }, () =>
        createDurably({ dialect: resource.createDialect() }),
      )

      await runtimes[0].migrate()
      await runtimes[0].db.deleteFrom('durably_logs').execute()
      await runtimes[0].db.deleteFrom('durably_steps').execute()
      await runtimes[0].db.deleteFrom('durably_runs').execute()
    })

    afterEach(async () => {
      if (runtimes) {
        await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
      }
      await resource.cleanup?.()
    })

    it('keeps claim single-winner across separate runtime instances', async () => {
      for (let attempt = 0; attempt < 25; attempt++) {
        await runtimes[0].db.deleteFrom('durably_logs').execute()
        await runtimes[0].db.deleteFrom('durably_steps').execute()
        await runtimes[0].db.deleteFrom('durably_runs').execute()

        const created = await runtimes[0].storage.enqueue({
          jobName: 'stress-job',
          input: { attempt, nonce: randomUUID() },
        })

        const now = new Date().toISOString()
        const results = await Promise.all(
          runtimes.map((runtime, index) =>
            runtime.storage.claimNext(`worker-${index}`, now, 30_000),
          ),
        )

        const winners = results.filter((run) => run !== null)
        expect(winners).toHaveLength(1)
        expect(winners[0]?.id).toBe(created.id)
      }
    })

    it('rejects stale completion after another runtime reclaims the lease', async () => {
      const created = await runtimes[0].storage.enqueue({
        jobName: 'stress-reclaim',
        input: { nonce: randomUUID() },
      })

      const firstClaim = await runtimes[0].storage.claimNext(
        'worker-a',
        new Date().toISOString(),
        30_000,
      )
      expect(firstClaim?.id).toBe(created.id)
      const firstGen = firstClaim!.leaseGeneration

      // Expire the lease so it can be reclaimed
      await runtimes[1].storage.updateRun(created.id, {
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const reclaimed = await runtimes[2].storage.claimNext(
        'worker-b',
        new Date().toISOString(),
        30_000,
      )

      expect(reclaimed?.id).toBe(created.id)
      expect(reclaimed?.leaseOwner).toBe('worker-b')
      const secondGen = reclaimed!.leaseGeneration

      // Stale worker tries to complete with old generation — should be rejected
      const staleComplete = await runtimes[3].storage.completeRun(
        created.id,
        firstGen,
        { ok: false },
        new Date().toISOString(),
      )
      // Current owner completes with correct generation — should succeed
      const currentComplete = await runtimes[2].storage.completeRun(
        created.id,
        secondGen,
        { ok: true },
        new Date().toISOString(),
      )

      expect(staleComplete).toBe(false)
      expect(currentComplete).toBe(true)
    })
  })
}
