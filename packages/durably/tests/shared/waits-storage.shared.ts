import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConflictError,
  createDurably,
  ValidationError,
  type Durably,
} from '../../src'

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
    const at = (offset: number) =>
      new Date(Date.UTC(2030, 0, 1) + offset).toISOString()
    async function timedWait(timeoutMs = 1000) {
      const store = durably.storage
      const { run } = await store.enqueue({ jobName: 'deadline', input: {} })
      const leased = (await store.claimNext('worker', at(0), 30_000))!
      const wait = (await store.prepareWait(
        run.id,
        leased.leaseGeneration,
        'approval',
        undefined,
        timeoutMs,
        at(0),
      ))!
      return { store, run, leased, wait }
    }

    it('validates and fixes the first absolute deadline across replays', async () => {
      const { store, run, leased, wait } = await timedWait()
      expect(wait.deadlineAt).toBe(at(1000))
      expect(wait.outcome).toBeNull()
      expect(
        (
          await store.prepareWait(
            run.id,
            leased.leaseGeneration,
            'approval',
            undefined,
            2000,
            at(100),
          )
        )?.deadlineAt,
      ).toBe(at(1000))
      expect(
        (
          await store.prepareWait(
            run.id,
            leased.leaseGeneration,
            'approval',
            undefined,
            undefined,
            at(100),
          )
        )?.deadlineAt,
      ).toBe(at(1000))
      for (const invalid of [
        0,
        -1,
        NaN,
        Infinity,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MAX_SAFE_INTEGER,
      ]) {
        await expect(
          store.prepareWait(
            run.id,
            leased.leaseGeneration,
            `invalid-${String(invalid)}`,
            undefined,
            invalid,
            at(0),
          ),
        ).rejects.toThrow(ValidationError)
      }
      const maxRepresentable = 8_640_000_000_000_000 - Date.parse(at(0))
      const maxWait = (await store.prepareWait(
        run.id,
        leased.leaseGeneration,
        'max-deadline',
        undefined,
        maxRepresentable,
        at(0),
      ))!
      expect(maxWait.deadlineAt).toBe('+275760-09-13T00:00:00.000Z')
      expect(await store.expireDueWaits(at(1))).toBe(0)
      expect((await store.getWait(maxWait.id))?.outcome).toBeNull()
      expect(
        (
          await store.signalWait(
            maxWait.id,
            true,
            { signalId: 'before-max' },
            at(1),
          )
        ).outcome,
      ).toBe('signal')
      await expect(
        store.prepareWait(
          run.id,
          leased.leaseGeneration,
          'beyond-max-deadline',
          undefined,
          maxRepresentable + 1,
          at(0),
        ),
      ).rejects.toThrow(ValidationError)
      expect(
        (
          await store.prepareWait(
            run.id,
            leased.leaseGeneration,
            'unbounded',
            undefined,
            undefined,
            at(0),
          )
        )?.deadlineAt,
      ).toBeNull()
    })

    it('accepts only before the deadline and keeps an identical retry', async () => {
      const { store, wait } = await timedWait()
      const receipt = await store.signalWait(
        wait.id,
        { approved: true },
        { signalId: 'accepted' },
        at(999),
      )
      expect(receipt.outcome).toBe('signal')
      expect(receipt.resolvedAt).toBe(at(999))
      expect(
        await store.signalWait(
          wait.id,
          { approved: true },
          { signalId: 'accepted' },
          at(2000),
        ),
      ).toEqual(receipt)
      const second = await timedWait()
      await expect(
        second.store.signalWait(
          second.wait.id,
          true,
          { signalId: 'late' },
          at(1000),
        ),
      ).rejects.toThrow(ConflictError)
      expect((await second.store.getWait(second.wait.id))?.outcome).toBe(
        'timeout',
      )
      expect((await second.store.getWait(second.wait.id))?.resolvedAt).toBe(
        at(1000),
      )
    })

    it('separates external-input and execution-slot time after suspension', async () => {
      const { store, run, leased, wait } = await timedWait()
      expect(
        await store.suspendRun(
          run.id,
          leased.leaseGeneration,
          wait.id,
          at(100),
        ),
      ).toBe(true)
      expect((await store.getWait(wait.id))?.suspendedAt).toBe(at(100))
      await store.signalWait(wait.id, null, { signalId: 'done' }, at(400))
      expect((await store.getWait(wait.id))?.inputWaitMs).toBe(300)
      expect((await store.getWait(wait.id))?.executionSlotWaitMs).toBeNull()
      expect((await store.claimNext('next', at(900), 30_000))?.id).toBe(run.id)
      const resumed = await store.getWait(wait.id)
      expect(resumed?.firstResumedAt).toBe(at(900))
      expect(resumed?.inputWaitMs).toBe(300)
      expect(resumed?.executionSlotWaitMs).toBe(500)
    })

    it('counts post-handoff queue time when signal wins just before suspension', async () => {
      const { store, run, leased, wait } = await timedWait()
      await store.signalWait(wait.id, null, { signalId: 'early' }, at(100))
      await store.suspendRun(run.id, leased.leaseGeneration, wait.id, at(200))
      expect((await store.getWait(wait.id))?.executionSlotWaitMs).toBeNull()
      await store.claimNext('next', at(500), 30_000)
      const result = await store.getWait(wait.id)
      expect(result?.suspendedAt).toBe(at(200))
      expect(result?.inputWaitMs).toBe(0)
      expect(result?.executionSlotWaitMs).toBe(300)
    })

    it('reports zero durations when an early signal is consumed without suspension', async () => {
      const { store, run, leased, wait } = await timedWait()
      await store.signalWait(wait.id, null, { signalId: 'early' }, at(100))
      expect(
        (
          await store.getWaitResultForRun(
            run.id,
            leased.leaseGeneration,
            wait.id,
            at(200),
          )
        )?.outcome,
      ).toBe('signal')
      const result = await store.getWait(wait.id)
      expect(result?.suspendedAt).toBeNull()
      expect(result?.inputWaitMs).toBe(0)
      expect(result?.executionSlotWaitMs).toBe(0)
    })

    it('expires an offline wait at its original deadline and resumes once', async () => {
      const { store, run, leased, wait } = await timedWait()
      await store.suspendRun(run.id, leased.leaseGeneration, wait.id, at(100))
      expect(await store.expireDueWaits(at(999))).toBe(0)
      expect(await store.expireDueWaits(at(2000))).toBe(1)
      expect(await store.expireDueWaits(at(2000))).toBe(0)
      expect((await store.getWait(wait.id))?.inputWaitMs).toBe(900)
      expect((await store.claimNext('next', at(2500), 30_000))?.id).toBe(run.id)
      const result = await store.getWait(wait.id)
      expect(result?.outcome).toBe('timeout')
      expect(result?.executionSlotWaitMs).toBe(1500)
    })

    it('finalizes timeout during a fenced replay read and never extends it', async () => {
      const { store, run, leased, wait } = await timedWait()
      expect(
        (
          await store.getWaitResultForRun(
            run.id,
            leased.leaseGeneration,
            wait.id,
            at(999),
          )
        )?.outcome,
      ).toBeNull()
      const timedOut = await store.getWaitResultForRun(
        run.id,
        leased.leaseGeneration,
        wait.id,
        at(1000),
      )
      expect(timedOut?.outcome).toBe('timeout')
      expect(timedOut?.resolvedAt).toBe(at(1000))
      expect(
        (
          await store.getWaitResultForRun(
            run.id,
            leased.leaseGeneration,
            wait.id,
            at(2000),
          )
        )?.resolvedAt,
      ).toBe(at(1000))
      expect(
        await store.getWaitResultForRun(
          run.id,
          leased.leaseGeneration + 1,
          wait.id,
          at(1000),
        ),
      ).toBeNull()
    })

    it('serializes timeout, signal, and cancellation without reviving the run', async () => {
      const first = await timedWait()
      await first.store.suspendRun(
        first.run.id,
        first.leased.leaseGeneration,
        first.wait.id,
        at(100),
      )
      await Promise.allSettled([
        first.store.signalWait(
          first.wait.id,
          'late',
          { signalId: 'late' },
          at(1000),
        ),
        first.store.expireDueWaits(at(1000)),
      ])
      expect((await first.store.getWait(first.wait.id))?.outcome).toBe(
        'timeout',
      )
      await first.store.cancelRun(first.run.id, at(1100))
      expect((await first.store.getRun(first.run.id))?.status).toBe('cancelled')
      expect(await first.store.claimNext('idle', at(1200), 30_000)).toBeNull()

      const second = await timedWait()
      await second.store.suspendRun(
        second.run.id,
        second.leased.leaseGeneration,
        second.wait.id,
        at(100),
      )
      await second.store.cancelRun(second.run.id, at(900))
      expect(await second.store.expireDueWaits(at(1000))).toBe(0)
      expect((await second.store.getWait(second.wait.id))?.status).toBe(
        'cancelled',
      )
      expect((await second.store.getWait(second.wait.id))?.outcome).toBeNull()
    })
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
