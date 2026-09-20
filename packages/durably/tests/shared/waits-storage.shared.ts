import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, createDurably, type Durably } from '../../src'

export function createWaitStorageTests(createDialect: () => Dialect) {
  let durably: Durably
  beforeEach(async () => {
    durably = createDurably({ dialect: createDialect() })
    await durably.migrate()
  })
  afterEach(async () => {
    await durably.db.destroy()
  })
  describe('durable waits', () => {
    async function setup(key?: string) {
      const store = durably.storage
      const { run } = await store.enqueue({
        jobName: 'wait-job',
        input: {},
        concurrencyKey: key,
      })
      const leased = (await store.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      ))!
      const wait = (await store.prepareWait(
        run.id,
        leased.leaseGeneration,
        'approval',
        { revision: 1 },
      ))!
      return { store, run, leased, wait }
    }

    it('persists early input and resumes the same run with a new fenced generation', async () => {
      const { store, run, leased, wait } = await setup()
      expect(
        await store.prepareWait(run.id, leased.leaseGeneration, 'approval'),
      ).toEqual(wait)
      const receipt = await store.signalWait(
        wait.id,
        { b: 2, a: 1 },
        { signalId: 'one' },
      )
      expect(
        await store.signalWait(wait.id, { a: 1, b: 2 }, { signalId: 'one' }),
      ).toEqual(receipt)
      await expect(
        store.signalWait(wait.id, null, { signalId: 'one' }),
      ).rejects.toThrow(ConflictError)
      await expect(
        store.signalWait(wait.id, { a: 1, b: 2 }, { signalId: 'two' }),
      ).rejects.toThrow(ConflictError)
      expect(
        await store.suspendRun(
          run.id,
          leased.leaseGeneration,
          wait.id,
          new Date().toISOString(),
        ),
      ).toBe(true)
      const resumed = (await store.claimNext(
        'next',
        new Date().toISOString(),
        30_000,
      ))!
      expect(resumed.id).toBe(run.id)
      expect(resumed.leaseGeneration).toBe(leased.leaseGeneration + 1)
      expect(
        await store.prepareWait(run.id, leased.leaseGeneration, 'stale'),
      ).toBeNull()
      expect(
        await store.suspendRun(
          run.id,
          leased.leaseGeneration,
          wait.id,
          new Date().toISOString(),
        ),
      ).toBe(false)
    })

    it('releases the key while waiting and survives repeated recovery alongside trailing pending', async () => {
      const { store, run, leased, wait } = await setup('key')
      await store.suspendRun(
        run.id,
        leased.leaseGeneration,
        wait.id,
        new Date().toISOString(),
      )
      expect(
        await store.claimNext('idle', new Date().toISOString(), 30_000),
      ).toBeNull()
      expect(
        (
          await store.enqueue({
            jobName: 'wait-job',
            input: {},
            concurrencyKey: 'key',
            coalesce: 'active',
          })
        ).run.id,
      ).toBe(run.id)
      const trailing = await store.enqueue({
        jobName: 'wait-job',
        input: {},
        concurrencyKey: 'key',
        coalesce: 'queue',
      })
      const other = (await store.claimNext(
        'other',
        new Date().toISOString(),
        30_000,
      ))!
      expect(other.id).toBe(trailing.run.id)
      await store.signalWait(wait.id, null, { signalId: 'done' })
      expect(
        await store.claimNext('blocked', new Date().toISOString(), 30_000),
      ).toBeNull()
      await store.completeRun(
        other.id,
        other.leaseGeneration,
        null,
        new Date().toISOString(),
      )
      const resumed = (await store.claimNext(
        'resume',
        new Date().toISOString(),
        30_000,
      ))!
      expect(resumed.id).toBe(run.id)
      await store.enqueue({
        jobName: 'wait-job',
        input: {},
        concurrencyKey: 'key',
        coalesce: 'queue',
      })
      const future = new Date(Date.now() + 60_000).toISOString()
      await store.releaseExpiredLeases(future)
      expect((await store.getRun(run.id))?.status).toBe('leased')
      expect((await store.claimNext('recover', future, 30_000))?.id).toBe(
        run.id,
      )
    })

    it('serializes signal with suspension, cancellation, and deletes wait history with the run', async () => {
      const { store, run, leased, wait } = await setup()
      await Promise.all([
        store.suspendRun(
          run.id,
          leased.leaseGeneration,
          wait.id,
          new Date().toISOString(),
        ),
        store.signalWait(wait.id, 'accepted', { signalId: 'one' }),
      ])
      const resumed = (await store.claimNext(
        'next',
        new Date().toISOString(),
        30_000,
      ))!
      const nextWait = (await store.prepareWait(
        run.id,
        resumed.leaseGeneration,
        'approval-2',
      ))!
      await store.suspendRun(
        run.id,
        resumed.leaseGeneration,
        nextWait.id,
        new Date().toISOString(),
      )
      await store.cancelRun(run.id, new Date().toISOString())
      expect((await store.getWait(nextWait.id))?.status).toBe('cancelled')
      await expect(
        store.signalWait(nextWait.id, 'late', { signalId: 'late' }),
      ).rejects.toThrow(ConflictError)
      expect(
        (await store.signalWait(wait.id, 'accepted', { signalId: 'one' }))
          .status,
      ).toBe('resolved')
      expect(
        await store.claimNext('idle', new Date().toISOString(), 30_000),
      ).toBeNull()
      await store.deleteRun(run.id)
      expect(await store.getWaits(run.id)).toEqual([])
    })

    it('accepts one concurrent signal and orders cancellation without revival', async () => {
      const { store, run, leased, wait } = await setup()
      await store.suspendRun(
        run.id,
        leased.leaseGeneration,
        wait.id,
        new Date().toISOString(),
      )
      const results = await Promise.allSettled([
        store.signalWait(wait.id, 'a', { signalId: 'a' }),
        store.signalWait(wait.id, 'b', { signalId: 'b' }),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      expect(
        results.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1)
      const resumed = (await store.claimNext(
        'resume',
        new Date().toISOString(),
        30_000,
      ))!
      const second = (await store.prepareWait(
        run.id,
        resumed.leaseGeneration,
        'second',
      ))!
      await Promise.allSettled([
        store.signalWait(second.id, 'answer', { signalId: 'answer' }),
        store.cancelRun(run.id, new Date().toISOString()),
      ])
      expect((await store.getRun(run.id))?.status).toBe('cancelled')
      expect(['resolved', 'cancelled']).toContain(
        (await store.getWait(second.id))?.status,
      )
      expect(
        await store.claimNext('idle', new Date().toISOString(), 30_000),
      ).toBeNull()
    })

    it('keeps early-input crash recovery claimable alongside pending runs', async () => {
      const { store, run, wait } = await setup('early')
      await store.signalWait(wait.id, null, { signalId: 'early' })
      await store.enqueue({
        jobName: 'wait-job',
        input: {},
        concurrencyKey: 'early',
        coalesce: 'queue',
      })
      const future = new Date(Date.now() + 60_000).toISOString()
      await store.releaseExpiredLeases(future)
      expect((await store.claimNext('recover', future, 30_000))?.id).toBe(
        run.id,
      )
    })

    it('rejects unknown IDs and non-JSON input, and closes unused waits on completion', async () => {
      const { store, run, leased, wait } = await setup()
      await expect(
        store.signalWait('missing', null, { signalId: 'one' }),
      ).rejects.toThrow('Wait not found')
      await expect(
        store.signalWait(wait.id, Number.NaN, { signalId: 'one' }),
      ).rejects.toThrow()
      await store.completeRun(
        run.id,
        leased.leaseGeneration,
        null,
        new Date().toISOString(),
      )
      expect((await store.getWait(wait.id))?.status).toBe('closed')
      await expect(
        store.signalWait(wait.id, null, { signalId: 'one' }),
      ).rejects.toThrow(ConflictError)
    })
  })
}
