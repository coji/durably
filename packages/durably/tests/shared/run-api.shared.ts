import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  defineJob,
  type Durably,
  type LogData,
  type ProgressData,
} from '../../src'

export function createRunApiTests(createDialect: () => Dialect) {
  describe('Run API', () => {
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

    describe('durably.getRun()', () => {
      it('returns a run by ID', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'get-run-test',
            input: z.object({ value: z.number() }),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({ value: 42 })
        const fetched = await d.getRun(run.id)

        expect(fetched).not.toBeNull()
        expect(fetched?.id).toBe(run.id)
        expect(fetched?.jobName).toBe('get-run-test')
        expect(fetched?.input).toEqual({ value: 42 })
        expect(fetched?.status).toBe('pending')
      })

      it('returns null for non-existent run', async () => {
        const fetched = await durably.getRun('non-existent-id')
        expect(fetched).toBeNull()
      })

      it('returns run with unknown output type', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'unknown-output-test',
            input: z.object({}),
            output: z.object({ result: z.string() }),
            run: async () => ({ result: 'hello' }),
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        // durably.getRun returns unknown output type
        const fetched = await d.getRun(run.id)
        expect(fetched?.output).toEqual({ result: 'hello' })
      })
    })

    describe('durably.getRuns()', () => {
      it('returns all runs', async () => {
        const d1 = durably.register({
          job1: defineJob({
            name: 'job1',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d2 = d1.register({
          job2: defineJob({
            name: 'job2',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await d2.jobs.job1.trigger({})
        await d2.jobs.job2.trigger({})
        await d2.jobs.job1.trigger({})

        const runs = await d2.getRuns()
        expect(runs).toHaveLength(3)
      })

      it('filters by status', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'status-filter-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await d.jobs.job.trigger({})
        await d.jobs.job.trigger({})

        d.start()

        await vi.waitFor(
          async () => {
            const completed = await d.getRuns({ status: 'completed' })
            expect(completed.length).toBeGreaterThanOrEqual(1)
          },
          { timeout: 1000 },
        )

        const pending = await d.getRuns({ status: 'pending' })
        const completed = await d.getRuns({ status: 'completed' })

        expect(pending.length + completed.length).toBe(2)
      })

      it('filters by jobName', async () => {
        const d1 = durably.register({
          job1: defineJob({
            name: 'filter-job-a',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d2 = d1.register({
          job2: defineJob({
            name: 'filter-job-b',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await d2.jobs.job1.trigger({})
        await d2.jobs.job1.trigger({})
        await d2.jobs.job2.trigger({})

        const runsA = await d2.getRuns({ jobName: 'filter-job-a' })
        const runsB = await d2.getRuns({ jobName: 'filter-job-b' })

        expect(runsA).toHaveLength(2)
        expect(runsB).toHaveLength(1)
      })

      it('returns runs sorted by created_at descending', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'sort-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })

        await d.jobs.job.trigger({ order: 1 })
        await new Promise((r) => setTimeout(r, 10))
        await d.jobs.job.trigger({ order: 2 })
        await new Promise((r) => setTimeout(r, 10))
        await d.jobs.job.trigger({ order: 3 })

        const runs = await d.getRuns()

        // Most recent first
        expect((runs[0].input as { order: number }).order).toBe(3)
        expect((runs[1].input as { order: number }).order).toBe(2)
        expect((runs[2].input as { order: number }).order).toBe(1)
      })

      it('supports limit option', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'limit-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })

        // Add slight delays to ensure distinct created_at timestamps
        for (let i = 1; i <= 5; i++) {
          await d.jobs.job.trigger({ order: i })
          if (i < 5) await new Promise((r) => setTimeout(r, 5))
        }

        const limited = await d.getRuns({
          jobName: 'limit-test',
          limit: 3,
        })
        expect(limited).toHaveLength(3)

        // Should get most recent (5, 4, 3 since sorted by created_at desc)
        expect((limited[0].input as { order: number }).order).toBe(5)
        expect((limited[1].input as { order: number }).order).toBe(4)
        expect((limited[2].input as { order: number }).order).toBe(3)
      })

      it('supports offset option', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'offset-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })

        // Add slight delays to ensure distinct created_at timestamps
        for (let i = 1; i <= 5; i++) {
          await d.jobs.job.trigger({ order: i })
          if (i < 5) await new Promise((r) => setTimeout(r, 5))
        }

        const offset = await d.getRuns({
          jobName: 'offset-test',
          offset: 2,
        })
        expect(offset).toHaveLength(3)

        // Should skip first 2 (5, 4) and get (3, 2, 1)
        expect((offset[0].input as { order: number }).order).toBe(3)
        expect((offset[1].input as { order: number }).order).toBe(2)
        expect((offset[2].input as { order: number }).order).toBe(1)
      })

      it('supports limit and offset together for pagination', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'pagination-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })

        // Add slight delays to ensure distinct created_at timestamps
        for (let i = 1; i <= 10; i++) {
          await d.jobs.job.trigger({ order: i })
          if (i < 10) await new Promise((r) => setTimeout(r, 5))
        }

        // Page 1: first 3 items
        const page1 = await d.getRuns({
          jobName: 'pagination-test',
          limit: 3,
          offset: 0,
        })
        expect(page1).toHaveLength(3)
        expect((page1[0].input as { order: number }).order).toBe(10)
        expect((page1[1].input as { order: number }).order).toBe(9)
        expect((page1[2].input as { order: number }).order).toBe(8)

        // Page 2: next 3 items
        const page2 = await d.getRuns({
          jobName: 'pagination-test',
          limit: 3,
          offset: 3,
        })
        expect(page2).toHaveLength(3)
        expect((page2[0].input as { order: number }).order).toBe(7)
        expect((page2[1].input as { order: number }).order).toBe(6)
        expect((page2[2].input as { order: number }).order).toBe(5)

        // Page 4: last page with only 1 item
        const page4 = await d.getRuns({
          jobName: 'pagination-test',
          limit: 3,
          offset: 9,
        })
        expect(page4).toHaveLength(1)
        expect((page4[0].input as { order: number }).order).toBe(1)
      })

      it('combines pagination with other filters', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'combined-filter-pagination-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })

        // Add slight delays to ensure distinct created_at timestamps
        for (let i = 1; i <= 6; i++) {
          await d.jobs.job.trigger({ order: i })
          if (i < 6) await new Promise((r) => setTimeout(r, 5))
        }

        const filtered = await d.getRuns({
          jobName: 'combined-filter-pagination-test',
          limit: 2,
          offset: 1,
        })

        expect(filtered).toHaveLength(2)
        // Should skip first (6) and get next 2 (5, 4)
        expect((filtered[0].input as { order: number }).order).toBe(5)
        expect((filtered[1].input as { order: number }).order).toBe(4)
      })

      it('returns empty array when offset exceeds total', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'offset-exceeds-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await d.jobs.job.trigger({})
        await d.jobs.job.trigger({})

        const result = await d.getRuns({
          jobName: 'offset-exceeds-test',
          offset: 10,
        })
        expect(result).toHaveLength(0)
      })
    })

    describe('triggerAndWait()', () => {
      it('triggers and waits for successful completion', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'trigger-and-wait-success',
            input: z.object({ value: z.number() }),
            output: z.object({ result: z.number() }),
            run: async (step, input) => {
              await step.run('compute', async () => {
                await new Promise((r) => setTimeout(r, 50))
              })
              return { result: input.value * 2 }
            },
          }),
        })

        d.start()

        const { id, output } = await d.jobs.job.triggerAndWait({ value: 21 })

        expect(id).toBeDefined()
        expect(output).toEqual({ result: 42 })

        // Verify run is completed
        const run = await d.jobs.job.getRun(id)
        expect(run?.status).toBe('completed')
      })

      it('rejects when job fails', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'trigger-and-wait-fail',
            input: z.object({}),
            output: z.object({}),
            run: async (step) => {
              await step.run('fail-step', async () => {
                throw new Error('Intentional failure')
              })
              return {}
            },
          }),
        })

        d.start()

        await expect(d.jobs.job.triggerAndWait({})).rejects.toThrow(
          'Intentional failure',
        )
      })

      it('works with options', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'trigger-and-wait-options',
            input: z.object({}),
            output: z.object({ done: z.boolean() }),
            run: async () => {
              return { done: true }
            },
          }),
        })

        d.start()

        const { output } = await d.jobs.job.triggerAndWait(
          {},
          { idempotencyKey: 'test-key' },
        )
        expect(output).toEqual({ done: true })

        // Verify idempotency key was used
        const runs = await d.jobs.job.getRuns()
        expect(runs[0].idempotencyKey).toBe('test-key')
      })

      it('times out if job does not complete within timeout', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'trigger-and-wait-timeout',
            input: z.object({}),
            output: z.object({}),
            run: async (step) => {
              await step.run('slow-step', async () => {
                // This step takes longer than the timeout
                await new Promise((r) => setTimeout(r, 500))
              })
              return {}
            },
          }),
        })

        // Don't start the worker - job will never complete
        // Or start with a delay that exceeds timeout

        await expect(
          d.jobs.job.triggerAndWait({}, { timeout: 100 }),
        ).rejects.toThrow('timeout')
      })

      it('calls onProgress callback with progress data', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'progress-callback-test',
            input: z.object({}),
            run: async (step) => {
              step.progress(1, 3, 'Step 1')
              await step.run('s1', () => 'done')
              step.progress(2, 3, 'Step 2')
              await step.run('s2', () => 'done')
              step.progress(3, 3, 'Done')
            },
          }),
        })

        d.start()

        const progressUpdates: ProgressData[] = []

        await d.jobs.job.triggerAndWait(
          {},
          {
            onProgress: (progress) => {
              progressUpdates.push(progress)
            },
          },
        )

        expect(progressUpdates).toHaveLength(3)
        expect(progressUpdates[0]).toEqual({
          current: 1,
          total: 3,
          message: 'Step 1',
        })
        expect(progressUpdates[2]).toEqual({
          current: 3,
          total: 3,
          message: 'Done',
        })
      })

      it('calls onLog callback with log data', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'log-callback-test',
            input: z.object({}),
            run: async (step) => {
              step.log.info('Starting')
              await step.run('s1', () => 'done')
              step.log.warn('Almost done')
              step.log.error('Something went wrong', { code: 42 })
            },
          }),
        })

        d.start()

        const logs: LogData[] = []

        await d.jobs.job.triggerAndWait(
          {},
          {
            onLog: (log) => {
              logs.push(log)
            },
          },
        )

        expect(logs).toHaveLength(3)
        expect(logs[0]).toMatchObject({ level: 'info', message: 'Starting' })
        expect(logs[1]).toMatchObject({ level: 'warn', message: 'Almost done' })
        expect(logs[2]).toMatchObject({
          level: 'error',
          message: 'Something went wrong',
          data: { code: 42 },
        })
      })
    })

    describe('labels schema validation', () => {
      it('rejects invalid labels on trigger()', async () => {
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          labels: z.object({
            organizationId: z.string(),
            env: z.string(),
          }),
        })
        await d.migrate()

        const registered = d.register({
          job: defineJob({
            name: 'labels-validation-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await expect(
          registered.jobs.job.trigger(
            {},
            // @ts-expect-error -- missing 'env'
            { labels: { organizationId: 'org_1' } },
          ),
        ).rejects.toThrow('labels')

        await d.db.destroy()
      })

      it('rejects invalid labels on batchTrigger()', async () => {
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          labels: z.object({
            organizationId: z.string(),
            env: z.string(),
          }),
        })
        await d.migrate()

        const registered = d.register({
          job: defineJob({
            name: 'labels-batch-validation-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        await expect(
          registered.jobs.job.batchTrigger([
            {
              input: {},
              // @ts-expect-error -- missing 'env'
              options: { labels: { organizationId: 'org_1' } },
            },
          ]),
        ).rejects.toThrow('labels')

        await d.db.destroy()
      })

      it('accepts valid labels on trigger()', async () => {
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          labels: z.object({
            organizationId: z.string(),
            env: z.string(),
          }),
        })
        await d.migrate()

        const registered = d.register({
          job: defineJob({
            name: 'labels-valid-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await registered.jobs.job.trigger(
          {},
          { labels: { organizationId: 'org_1', env: 'prod' } },
        )
        expect(run.labels).toEqual({
          organizationId: 'org_1',
          env: 'prod',
        })

        await d.db.destroy()
      })
    })

    describe('step.progress()', () => {
      it('saves progress with current value', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'progress-test',
            input: z.object({}),
            run: async (step) => {
              step.progress(50)
              await step.run('step', async () => {
                await new Promise((r) => setTimeout(r, 50))
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.progress).not.toBeNull()
          },
          { timeout: 1000 },
        )

        const midRun = await d.jobs.job.getRun(run.id)
        expect(midRun?.progress?.current).toBe(50)
      })

      it('saves progress with all fields', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'full-progress-test',
            input: z.object({}),
            run: async (step) => {
              step.progress(25, 100, 'Processing items...')
              await step.run('step', async () => {
                await new Promise((r) => setTimeout(r, 50))
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.progress).not.toBeNull()
          },
          { timeout: 1000 },
        )

        const midRun = await d.jobs.job.getRun(run.id)
        expect(midRun?.progress).toEqual({
          current: 25,
          total: 100,
          message: 'Processing items...',
        })
      })

      it('progress is available via getRun()', async () => {
        let progressSet = false

        const d = durably.register({
          job: defineJob({
            name: 'get-progress-test',
            input: z.object({}),
            run: async (step) => {
              step.progress(75, 100)
              progressSet = true
              await step.run('wait', async () => {
                await new Promise((r) => setTimeout(r, 100))
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            expect(progressSet).toBe(true)
          },
          { timeout: 500 },
        )

        // Give time for async progress update
        await new Promise((r) => setTimeout(r, 50))

        const fetched = await d.getRun(run.id)
        expect(fetched?.progress?.current).toBe(75)
        expect(fetched?.progress?.total).toBe(100)
      })
    })
  })
}
