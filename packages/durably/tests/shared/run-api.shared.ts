import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably } from '../../src'

export function createRunApiTests(createDialect: () => Dialect) {
  describe('Run API', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    describe('durably.getRun()', () => {
      it('returns a run by ID', async () => {
        const job = durably.defineJob(
          {
            name: 'get-run-test',
            input: z.object({ value: z.number() }),
          },
          async () => {},
        )

        const run = await job.trigger({ value: 42 })
        const fetched = await durably.getRun(run.id)

        expect(fetched).not.toBeNull()
        expect(fetched?.id).toBe(run.id)
        expect(fetched?.jobName).toBe('get-run-test')
        expect(fetched?.payload).toEqual({ value: 42 })
        expect(fetched?.status).toBe('pending')
      })

      it('returns null for non-existent run', async () => {
        const fetched = await durably.getRun('non-existent-id')
        expect(fetched).toBeNull()
      })

      it('returns run with unknown output type', async () => {
        const job = durably.defineJob(
          {
            name: 'unknown-output-test',
            input: z.object({}),
            output: z.object({ result: z.string() }),
          },
          async () => ({ result: 'hello' }),
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        // durably.getRun returns unknown output type
        const fetched = await durably.getRun(run.id)
        expect(fetched?.output).toEqual({ result: 'hello' })
      })
    })

    describe('durably.getRuns()', () => {
      it('returns all runs', async () => {
        const job1 = durably.defineJob(
          { name: 'job1', input: z.object({}) },
          async () => {},
        )
        const job2 = durably.defineJob(
          { name: 'job2', input: z.object({}) },
          async () => {},
        )

        await job1.trigger({})
        await job2.trigger({})
        await job1.trigger({})

        const runs = await durably.getRuns()
        expect(runs).toHaveLength(3)
      })

      it('filters by status', async () => {
        const job = durably.defineJob(
          { name: 'status-filter-test', input: z.object({}) },
          async () => {},
        )

        await job.trigger({})
        await job.trigger({})

        durably.start()

        await vi.waitFor(
          async () => {
            const completed = await durably.getRuns({ status: 'completed' })
            expect(completed.length).toBeGreaterThanOrEqual(1)
          },
          { timeout: 1000 },
        )

        const pending = await durably.getRuns({ status: 'pending' })
        const completed = await durably.getRuns({ status: 'completed' })

        expect(pending.length + completed.length).toBe(2)
      })

      it('filters by jobName', async () => {
        const job1 = durably.defineJob(
          { name: 'filter-job-a', input: z.object({}) },
          async () => {},
        )
        const job2 = durably.defineJob(
          { name: 'filter-job-b', input: z.object({}) },
          async () => {},
        )

        await job1.trigger({})
        await job1.trigger({})
        await job2.trigger({})

        const runsA = await durably.getRuns({ jobName: 'filter-job-a' })
        const runsB = await durably.getRuns({ jobName: 'filter-job-b' })

        expect(runsA).toHaveLength(2)
        expect(runsB).toHaveLength(1)
      })

      it('returns runs sorted by created_at descending', async () => {
        const job = durably.defineJob(
          { name: 'sort-test', input: z.object({ order: z.number() }) },
          async () => {},
        )

        await job.trigger({ order: 1 })
        await new Promise((r) => setTimeout(r, 10))
        await job.trigger({ order: 2 })
        await new Promise((r) => setTimeout(r, 10))
        await job.trigger({ order: 3 })

        const runs = await durably.getRuns()

        // Most recent first
        expect((runs[0].payload as { order: number }).order).toBe(3)
        expect((runs[1].payload as { order: number }).order).toBe(2)
        expect((runs[2].payload as { order: number }).order).toBe(1)
      })
    })

    describe('ctx.progress()', () => {
      it('saves progress with current value', async () => {
        const job = durably.defineJob(
          { name: 'progress-test', input: z.object({}) },
          async (ctx) => {
            ctx.progress(50)
            await ctx.run('step', async () => {
              await new Promise((r) => setTimeout(r, 50))
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.progress).not.toBeNull()
          },
          { timeout: 1000 },
        )

        const midRun = await job.getRun(run.id)
        expect(midRun?.progress?.current).toBe(50)
      })

      it('saves progress with all fields', async () => {
        const job = durably.defineJob(
          { name: 'full-progress-test', input: z.object({}) },
          async (ctx) => {
            ctx.progress(25, 100, 'Processing items...')
            await ctx.run('step', async () => {
              await new Promise((r) => setTimeout(r, 50))
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.progress).not.toBeNull()
          },
          { timeout: 1000 },
        )

        const midRun = await job.getRun(run.id)
        expect(midRun?.progress).toEqual({
          current: 25,
          total: 100,
          message: 'Processing items...',
        })
      })

      it('progress is available via getRun()', async () => {
        let progressSet = false

        const job = durably.defineJob(
          { name: 'get-progress-test', input: z.object({}) },
          async (ctx) => {
            ctx.progress(75, 100)
            progressSet = true
            await ctx.run('wait', async () => {
              await new Promise((r) => setTimeout(r, 100))
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            expect(progressSet).toBe(true)
          },
          { timeout: 500 },
        )

        // Give time for async progress update
        await new Promise((r) => setTimeout(r, 50))

        const fetched = await durably.getRun(run.id)
        expect(fetched?.progress?.current).toBe(75)
        expect(fetched?.progress?.total).toBe(100)
      })
    })
  })
}
