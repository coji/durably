import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'

export function createPurgeTests(createDialect: () => Dialect) {
  describe('purgeRuns', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    const testJob = defineJob({
      name: 'purge-test-job',
      input: z.object({}),
      run: async () => {},
    })

    const failingJob = defineJob({
      name: 'purge-failing-job',
      input: z.object({}),
      run: async () => {
        throw new Error('fail')
      },
    })

    describe('durably.purgeRuns()', () => {
      it('deletes completed runs older than cutoff', async () => {
        const d = durably.register({ testJob })
        d.start()

        const run = await d.jobs.testJob.trigger({})

        await vi.waitFor(
          async () => {
            const r = await d.getRun(run.id)
            expect(r?.status).toBe('completed')
          },
          { timeout: 5000 },
        )

        // Purge with cutoff in the future — should delete the run
        const futureDate = new Date(Date.now() + 60000)
        const deleted = await d.purgeRuns({ olderThan: futureDate })

        expect(deleted).toBe(1)
        expect(await d.getRun(run.id)).toBeNull()
      })

      it('deletes failed runs older than cutoff', async () => {
        const d = durably.register({ failingJob })
        d.start()

        const run = await d.jobs.failingJob.trigger({})

        await vi.waitFor(
          async () => {
            const r = await d.getRun(run.id)
            expect(r?.status).toBe('failed')
          },
          { timeout: 5000 },
        )

        const futureDate = new Date(Date.now() + 60000)
        const deleted = await d.purgeRuns({ olderThan: futureDate })

        expect(deleted).toBe(1)
        expect(await d.getRun(run.id)).toBeNull()
      })

      it('deletes cancelled runs older than cutoff', async () => {
        const d = durably.register({ testJob })

        const run = await d.jobs.testJob.trigger({})
        await d.cancel(run.id)

        const futureDate = new Date(Date.now() + 60000)
        const deleted = await d.purgeRuns({ olderThan: futureDate })

        expect(deleted).toBe(1)
        expect(await d.getRun(run.id)).toBeNull()
      })

      it('does NOT delete pending or leased runs', async () => {
        const d = durably.register({ testJob })

        // Create a pending run (don't start worker)
        const run = await d.jobs.testJob.trigger({})

        const futureDate = new Date(Date.now() + 60000)
        const deleted = await d.purgeRuns({ olderThan: futureDate })

        expect(deleted).toBe(0)
        expect(await d.getRun(run.id)).not.toBeNull()
      })

      it('does NOT delete runs newer than cutoff', async () => {
        const d = durably.register({ testJob })
        d.start()

        const run = await d.jobs.testJob.trigger({})

        await vi.waitFor(
          async () => {
            const r = await d.getRun(run.id)
            expect(r?.status).toBe('completed')
          },
          { timeout: 5000 },
        )

        // Purge with cutoff in the past — should not delete
        const pastDate = new Date(Date.now() - 60000)
        const deleted = await d.purgeRuns({ olderThan: pastDate })

        expect(deleted).toBe(0)
        expect(await d.getRun(run.id)).not.toBeNull()
      })

      it('respects the limit parameter', async () => {
        const d = durably.register({ testJob })
        d.start()

        // Trigger 3 runs
        await d.jobs.testJob.trigger({})
        await d.jobs.testJob.trigger({})
        await d.jobs.testJob.trigger({})

        await vi.waitFor(
          async () => {
            const runs = await d.getRuns({ status: 'completed' })
            expect(runs.length).toBe(3)
          },
          { timeout: 5000 },
        )

        const futureDate = new Date(Date.now() + 60000)
        const deleted = await d.purgeRuns({ olderThan: futureDate, limit: 2 })

        expect(deleted).toBe(2)
        const remaining = await d.getRuns()
        expect(remaining.length).toBe(1)
      })

      it('returns 0 when no runs match', async () => {
        const d = durably.register({ testJob })
        const deleted = await d.purgeRuns({
          olderThan: new Date(Date.now() + 60000),
        })
        expect(deleted).toBe(0)
      })

      it('also deletes associated steps', async () => {
        const jobWithSteps = defineJob({
          name: 'purge-steps-job',
          input: z.object({}),
          run: async (ctx) => {
            await ctx.run('step1', () => 'result1')
            await ctx.run('step2', () => 'result2')
          },
        })

        // preserveSteps: true so steps remain after completion
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          preserveSteps: true,
        }).register({ jobWithSteps })

        await d.migrate()
        d.start()
        const run = await d.jobs.jobWithSteps.trigger({})

        await vi.waitFor(
          async () => {
            const r = await d.getRun(run.id)
            expect(r?.status).toBe('completed')
          },
          { timeout: 5000 },
        )

        // Verify steps exist before purge
        const steps = await d.storage.getSteps(run.id)
        expect(steps.length).toBeGreaterThan(0)

        const futureDate = new Date(Date.now() + 60000)
        await d.purgeRuns({ olderThan: futureDate })

        // Steps should be gone too
        const stepsAfter = await d.storage.getSteps(run.id)
        expect(stepsAfter.length).toBe(0)

        await d.stop()
        await d.db.destroy()
      })
    })

    describe('retainRuns option', () => {
      it('auto-purges old runs during worker polling', async () => {
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          retainRuns: '1m', // 1 minute retention
        }).register({ testJob })

        await d.migrate()
        d.start()

        const run = await d.jobs.testJob.trigger({})

        await vi.waitFor(
          async () => {
            const r = await d.getRun(run.id)
            expect(r?.status).toBe('completed')
          },
          { timeout: 5000 },
        )

        // Run just completed — should NOT be purged (it's not 1 minute old)
        // Wait a polling cycle to ensure auto-purge ran
        await new Promise((r) => setTimeout(r, 200))
        expect(await d.getRun(run.id)).not.toBeNull()

        await d.stop()
        await d.db.destroy()
      })

      it('throws on invalid retainRuns format', () => {
        expect(() =>
          createDurably({
            dialect: createDialect(),
            retainRuns: 'invalid',
          }),
        ).toThrow('Invalid duration format')
      })

      it('throws on invalid retainRuns unit', () => {
        expect(() =>
          createDurably({
            dialect: createDialect(),
            retainRuns: '30s',
          }),
        ).toThrow('Invalid duration format')
      })
    })
  })
}
