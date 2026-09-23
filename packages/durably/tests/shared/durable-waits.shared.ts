import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createDurably,
  createDurablyHandler,
  defineJob,
  type Durably,
} from '../../src'

function gate() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Long enough that the first `processOne` always suspends the run before the
// deadline passes, even on a loaded machine; a 100ms deadline could expire
// between `prepareWait` and `waitFor`, and the run then finished early.
const WAIT_DEADLINE_MS = 1_000

export function createDurableWaitTests(createDialect: () => Dialect) {
  describe('durable wait runtime', () => {
    let d: Durably
    beforeEach(async () => {
      d = createDurably({ dialect: createDialect(), pollingIntervalMs: 10 })
      await d.migrate()
    })
    afterEach(async () => {
      await d.stop()
      await d.db.destroy()
      vi.useRealTimers()
    })

    it('suspends a run even when its worker clock lags the database', async () => {
      const databaseTime = Date.now()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(databaseTime - 60_000))
      const app = d.register({
        job: defineJob({
          name: 'slow-clock-wait',
          input: z.object({}),
          run: async (step) => {
            await step.waitFor(
              await step.prepareWait('approval', { timeoutMs: 10_000 }),
            )
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.status).toBe('waiting')
      const [wait] = await app.getWaits(run.id)
      expect(Math.abs(Date.parse(wait.createdAt) - databaseTime)).toBeLessThan(
        5_000,
      )
    })

    it('releases one worker slot and same-key exclusion, then replays checkpoints on the same run', async () => {
      const callback = vi.fn(() => 'saved')
      const continuation = vi.fn()
      const app = d.register({
        job: defineJob({
          name: 'wait',
          output: z.unknown(),
          input: z.object({ wait: z.boolean() }),
          run: async (step, input) => {
            await step.run('before', callback)
            if (input.wait) {
              const wait = await step.prepareWait('approval', {
                metadata: { target: 'review-1' },
              })
              const result = await step.waitFor(wait)
              if (result.type !== 'signal')
                throw new Error('Unexpected timeout')
              await step.run('after', () => continuation(result.payload))
              return result.payload
            }
            return 'other'
          },
        }),
      })
      const a = await app.jobs.job.trigger(
        { wait: true },
        { concurrencyKey: 'key' },
      )
      app.start()
      await vi.waitFor(
        async () => expect((await app.getRun(a.id))?.status).toBe('waiting'),
        { timeout: 5_000 },
      )
      const b = await app.jobs.job.trigger(
        { wait: false },
        { concurrencyKey: 'key' },
      )
      await app.waitForRun(b.id, { timeout: 5_000 })
      await app.stop()
      expect(callback).toHaveBeenCalledTimes(2)
      const [wait] = await app.getWaits(a.id)
      expect(wait.metadata).toEqual({ target: 'review-1' })
      const receipt = await app.signal(
        wait.id,
        { approved: true },
        { signalId: 'approval-1' },
      )
      expect(
        await app.signal(
          wait.id,
          { approved: true },
          { signalId: 'approval-1' },
        ),
      ).toEqual(receipt)
      app.start()
      const complete = await app.waitForRun(a.id, { timeout: 5_000 })
      await app.stop()
      expect(complete.output).toEqual({ approved: true })
      expect(callback).toHaveBeenCalledTimes(2)
      expect(continuation).toHaveBeenCalledTimes(1)
      expect(await app.getStepAttempts(a.id)).toHaveLength(2)
      expect(await app.storage.getSteps(a.id)).toHaveLength(0)
      expect(await app.getWait(wait.id)).toMatchObject({
        id: receipt.id,
        outcome: 'signal',
        payload: receipt.payload,
        resolvedAt: receipt.resolvedAt,
      })
    })

    it('accepts early input without suspending or recording wait attempts', async () => {
      const waiting = vi.fn()
      d.on('run:waiting', waiting)
      const app = d.register({
        job: defineJob({
          name: 'early',
          output: z.unknown(),
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('early')
            await d.signal(wait.id, null, { signalId: 's' })
            return await step.waitFor(wait)
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.output).toEqual({
        type: 'signal',
        payload: null,
      })
      expect(waiting).not.toHaveBeenCalled()
      expect(await app.getStepAttempts(run.id)).toEqual([])
    })

    it('resumes a timed-out run with a distinct result and separates input from slot waiting', async () => {
      const after = vi.fn()
      const app = d.register({
        job: defineJob({
          name: 'deadline',
          input: z.object({}),
          output: z.unknown(),
          run: async (step) => {
            const wait = await step.prepareWait('approval', {
              timeoutMs: WAIT_DEADLINE_MS,
            })
            const result = await step.waitFor(wait)
            await step.run('after', () => after(result))
            return result
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.status).toBe('waiting')
      const [initial] = await app.getWaits(run.id)
      expect(
        Date.parse(initial.deadlineAt!) - Date.parse(initial.createdAt),
      ).toBe(WAIT_DEADLINE_MS)

      // The deadline is in database time, so poll until the database agrees
      // it has passed rather than sleeping by the host clock.
      await vi.waitFor(async () => expect(await app.processOne()).toBe(true), {
        timeout: 5_000,
        interval: 20,
      })
      expect((await app.getRun(run.id))?.output).toEqual({ type: 'timeout' })
      expect(after).toHaveBeenCalledExactlyOnceWith({ type: 'timeout' })
      const wait = await app.getWait(initial.id)
      expect(wait?.outcome).toBe('timeout')
      expect(wait?.resolvedAt).toBe(initial.deadlineAt)
      expect(Date.parse(wait!.firstResumedAt!)).toBeGreaterThanOrEqual(
        Date.parse(initial.deadlineAt!),
      )
      expect(wait?.inputWaitMs).toBeGreaterThanOrEqual(0)
      expect(wait?.inputWaitMs).toBeLessThanOrEqual(WAIT_DEADLINE_MS)
      expect(wait?.executionSlotWaitMs).toBeGreaterThanOrEqual(0)
    })

    it('returns an early timeout without suspending the run', async () => {
      const waiting = vi.fn()
      d.on('run:waiting', waiting)
      const app = d.register({
        job: defineJob({
          name: 'early-timeout',
          input: z.object({}),
          output: z.unknown(),
          run: async (step) => {
            const wait = await step.prepareWait('approval', {
              timeoutMs: 1,
            })
            await new Promise((resolve) => setTimeout(resolve, 10))
            return step.waitFor(wait)
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.output).toEqual({ type: 'timeout' })
      expect(waiting).not.toHaveBeenCalled()
      expect((await app.getWaits(run.id))[0]).toMatchObject({
        suspendedAt: null,
        firstResumedAt: null,
        inputWaitMs: 0,
        executionSlotWaitMs: 0,
      })
    })

    it('cancellation after timeout finalization prevents continuation', async () => {
      const after = vi.fn()
      const app = d.register({
        job: defineJob({
          name: 'cancelled-timeout',
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('approval', {
              timeoutMs: WAIT_DEADLINE_MS,
            })
            await step.waitFor(wait)
            await step.run('after', after)
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      const [wait] = await app.getWaits(run.id)
      // Finalize the timeout without claiming the run, polling by database
      // time rather than sleeping by the host clock.
      await vi.waitFor(
        async () => {
          await app.storage.expireDueWaits()
          expect((await app.getWait(wait.id))?.outcome).toBe('timeout')
        },
        { timeout: 5_000, interval: 20 },
      )
      await expect(
        app.signal(wait.id, true, { signalId: 'late' }),
      ).rejects.toThrow()
      expect((await app.getWait(wait.id))?.outcome).toBe('timeout')
      await app.cancel(run.id)
      expect(await app.processOne()).toBe(false)
      expect((await app.getRun(run.id))?.status).toBe('cancelled')
      expect(after).not.toHaveBeenCalled()
    })

    it('does not hand off while finally is running, even after input arrives', async () => {
      const entered = gate()
      const release = gate()
      const continuation = vi.fn()
      const app = d.register({
        job: defineJob({
          name: 'unwind',
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('approval')
            try {
              await step.waitFor(wait)
            } finally {
              entered.resolve()
              await release.promise
            }
            continuation()
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      const processing = app.processOne()
      await entered.promise
      const [wait] = await app.getWaits(run.id)
      await app.signal(wait.id, true, { signalId: 's' })
      expect(await app.processOne()).toBe(false)
      expect((await app.getRun(run.id))?.status).toBe('leased')
      release.resolve()
      await processing
      expect((await app.getRun(run.id))?.status).toBe('waiting')
      expect(continuation).not.toHaveBeenCalled()
      await app.processOne()
      expect(continuation).toHaveBeenCalledTimes(1)
    })

    it('a caught suspension cannot complete the job or start another step', async () => {
      const effect = vi.fn()
      const app = d.register({
        job: defineJob({
          name: 'catch',
          output: z.unknown(),
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('approval')
            try {
              await step.waitFor(wait)
            } catch {
              await expect(step.run('wrong', effect)).rejects.toThrow(
                'suspended',
              )
              return 'incorrect-completion'
            }
            return 'done'
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.status).toBe('waiting')
      expect(effect).not.toHaveBeenCalled()
      const [wait] = await app.getWaits(run.id)
      await app.signal(wait.id, true, { signalId: 's' })
      await app.processOne()
      expect((await app.getRun(run.id))?.output).toBe('done')
    })

    it('rejects waits inside callbacks and settles live sibling callbacks before releasing a slot', async () => {
      const started = gate()
      const release = gate()
      const app = d.register({
        job: defineJob({
          name: 'illegal',
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('approval')
            await step.all({
              invalid: async () => {
                await started.promise
                return step.waitFor(wait)
              },
              sibling: async () => {
                started.resolve()
                await release.promise
                return 1
              },
            })
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      let finished = false
      const processing = app.processOne().then(() => {
        finished = true
      })
      await started.promise
      await Promise.resolve()
      expect(finished).toBe(false)
      release.resolve()
      await processing
      expect((await app.getRun(run.id))?.status).toBe('failed')
      expect((await app.getRun(run.id))?.error).toContain(
        'sequential job boundary',
      )
    })

    it('rejects a wait racing step startup before the callback begins', async () => {
      const app = d.register({
        job: defineJob({
          name: 'race-step',
          output: z.unknown(),
          input: z.object({}),
          run: async (step) => {
            const wait = await step.prepareWait('approval')
            const work = step.run('work', () => 1)
            await expect(step.waitFor(wait)).rejects.toThrow(
              'sequential job boundary',
            )
            await work
            return 'done'
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      expect((await app.getRun(run.id))?.status).toBe('completed')
    })

    it('only the awaited input resumes the run and old iterations cannot satisfy new waits', async () => {
      const app = d.register({
        job: defineJob({
          name: 'iterations',
          input: z.object({}),
          run: async (step) => {
            await step.prepareWait('unused')
            for (const name of ['round-1', 'round-2'])
              await step.waitFor(await step.prepareWait(name))
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      let waits = await app.getWaits(run.id)
      const unused = waits.find((w) => w.name === 'unused')
      const first = waits.find((w) => w.name === 'round-1')
      if (!unused || !first) throw new Error('Wait preparation failed')
      await app.signal(unused.id, true, { signalId: 'unused' })
      expect(await app.processOne()).toBe(false)
      await app.signal(first.id, true, { signalId: 'first' })
      await app.processOne()
      await app.signal(first.id, true, { signalId: 'first' })
      expect(await app.processOne()).toBe(false)
      waits = await app.getWaits(run.id)
      await app.signal(waits.find((w) => w.name === 'round-2')!.id, false, {
        signalId: 'second',
      })
      await app.processOne()
      expect((await app.getRun(run.id))?.status).toBe('completed')
    })

    it('replays waiting state to a new subscription and cancellation closes it with checkpoint cleanup', async () => {
      const app = d.register({
        job: defineJob({
          name: 'cancel-wait',
          input: z.object({}),
          run: async (step) => {
            step.progress(1, 2, 'Awaiting approval')
            await step.run('before', () => 42)
            await step.waitFor(await step.prepareWait('approval'))
          },
        }),
      })
      const run = await app.jobs.job.trigger({})
      await app.processOne()
      const handler = createDurablyHandler(app)
      const response = await handler.handle(
        new Request('http://localhost/api/durably/runs?status=waiting'),
        '/api/durably',
      )
      expect(response.status).toBe(200)
      const list = await response.json()
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: run.id,
            status: 'waiting',
            isActive: false,
            isTerminal: false,
            isWaiting: true,
          }),
        ]),
      )
      const reader = app.subscribe(run.id).getReader()
      expect((await reader.read()).value?.type).toBe('run:waiting')
      expect((await reader.read()).value).toMatchObject({
        type: 'run:progress',
        progress: { current: 1, total: 2, message: 'Awaiting approval' },
      })
      await expect(app.deleteRun(run.id)).rejects.toThrow('waiting')
      await expect(app.retrigger(run.id)).rejects.toThrow('waiting')
      await app.cancel(run.id)
      expect((await reader.read()).value?.type).toBe('run:cancel')
      expect((await reader.read()).done).toBe(true)
      expect(await app.storage.getSteps(run.id)).toEqual([])
      const [wait] = await app.getWaits(run.id)
      await expect(
        app.signal(wait.id, true, { signalId: 'late' }),
      ).rejects.toThrow()
      expect(await app.processOne()).toBe(false)
      const fresh = await app.retrigger(run.id)
      await app.processOne()
      expect((await app.getWaits(fresh.id))[0].id).not.toBe(wait.id)
      await app.deleteRun(run.id)
      expect(await app.getWait(wait.id)).toBeNull()
    })
  })
}
