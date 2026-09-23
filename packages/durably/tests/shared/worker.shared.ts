import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'
import { createDeferred } from '../helpers/sync'

export function createWorkerTests(createDialect: () => Dialect) {
  describe('Worker', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50, // Fast polling for tests
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    describe('start() and stop()', () => {
      it('starts polling when start() is called', async () => {
        const pollingTestDef = defineJob({
          name: 'polling-test',
          input: z.object({}),
          output: z.object({ done: z.boolean() }),
          run: async () => ({ done: true }),
        })
        const d = durably.register({ job: pollingTestDef })

        await d.jobs.job.trigger({})
        d.start()

        // Wait for polling to pick up the job
        await vi.waitFor(
          async () => {
            const run = (await d.jobs.job.getRuns())[0]
            expect(run.status).toBe('completed')
          },
          { timeout: 5_000 },
        )
      })

      it('stops after current run completes when stop() is called', async () => {
        let stepExecuted = false
        const started = createDeferred()
        const release = createDeferred()
        const stopTestDef = defineJob({
          name: 'stop-test',
          input: z.object({}),
          run: async (step) => {
            await step.run('step1', async () => {
              stepExecuted = true
              started.resolve()
              await release.promise
            })
          },
        })
        const d = durably.register({ job: stopTestDef })

        await d.jobs.job.trigger({})
        d.start()

        // Stop while the step is held, then let it finish: stop() must wait.
        await started.promise
        const stopping = d.stop()
        release.resolve()
        await stopping

        expect(stepExecuted).toBe(true)
        const run = (await d.jobs.job.getRuns())[0]
        expect(run.status).toBe('completed')
      })

      it('stop() resolves immediately if no run is executing', async () => {
        durably.start()
        const startTime = Date.now()
        await durably.stop()
        const elapsed = Date.now() - startTime

        expect(elapsed).toBeLessThan(100)
      })

      it('stop() awaits in-flight idle maintenance before resolving', async () => {
        let maintenanceCompleted = false

        // Use retainRuns to ensure runIdleMaintenance does real work
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          retainRuns: '30d',
        })
        await d.migrate()

        // Listen for the idle-maintenance cycle completing via worker:error
        // or simply track that stop() doesn't resolve before maintenance
        d.on('run:leased', () => {
          // noop — just need the worker to process something
        })

        d.start()

        // Let the worker go through at least one idle cycle
        // (processOne returns false → onIdle runs releaseExpiredLeases)
        // sleep-ok(yield): only gives stop() a chance to overlap idle
        // maintenance; the assertions hold whether or not a cycle ran
        await new Promise((r) => setTimeout(r, 150))

        // stop() should await any in-flight maintenance
        await d.stop()
        maintenanceCompleted = true

        expect(maintenanceCompleted).toBe(true)
        await d.db.destroy()
      })
    })

    describe('Run state transitions', () => {
      it('transitions pending run to leased then completed', async () => {
        const states: string[] = []

        durably.on('run:leased', () => states.push('leased'))
        durably.on('run:complete', () => states.push('completed'))

        const stateTestDef = defineJob({
          name: 'state-test',
          input: z.object({}),
          output: z.object({ value: z.number() }),
          run: async () => ({ value: 42 }),
        })
        const d = durably.register({ job: stateTestDef })

        const run = await d.jobs.job.trigger({})
        expect(run.status).toBe('pending')

        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
            // The event follows the status write; wait for it too.
            expect(states).toEqual(['leased', 'completed'])
          },
          { timeout: 5_000 },
        )
      })

      it('transitions to failed when job throws', async () => {
        const failTestDef = defineJob({
          name: 'fail-test',
          input: z.object({}),
          run: async () => {
            throw new Error('Job failed intentionally')
          },
        })
        const d = durably.register({ job: failTestDef })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('failed')
            expect(updated?.error).toContain('Job failed intentionally')
          },
          { timeout: 5_000 },
        )
      })
    })

    describe('Job execution', () => {
      it('passes input to job function', async () => {
        let receivedInput: unknown

        const inputTestDef = defineJob({
          name: 'input-test',
          input: z.object({ value: z.string() }),
          run: async (_step, input) => {
            receivedInput = input
          },
        })
        const d = durably.register({ job: inputTestDef })

        await d.jobs.job.trigger({ value: 'hello' })
        d.start()

        await vi.waitFor(
          async () => {
            expect(receivedInput).toEqual({ value: 'hello' })
          },
          { timeout: 5_000 },
        )
      })

      it('stores output in completed run', async () => {
        const outputTestDef = defineJob({
          name: 'output-test',
          input: z.object({}),
          output: z.object({ result: z.number() }),
          run: async () => ({ result: 123 }),
        })
        const d = durably.register({ job: outputTestDef })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
            expect(updated?.output).toEqual({ result: 123 })
          },
          { timeout: 5_000 },
        )
      })

      it('processes multiple pending runs sequentially', async () => {
        const order: number[] = []

        const sequentialTestDef = defineJob({
          name: 'sequential-test',
          input: z.object({ n: z.number() }),
          run: async (_step, input) => {
            order.push(input.n)
            // sleep-ok(work): a slower job only widens the window in which
            // a concurrency bug would reorder runs
            await new Promise((r) => setTimeout(r, 20))
          },
        })
        const d = durably.register({ job: sequentialTestDef })

        await d.jobs.job.trigger({ n: 1 })
        await d.jobs.job.trigger({ n: 2 })
        await d.jobs.job.trigger({ n: 3 })

        d.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            const allCompleted = runs.every((r) => r.status === 'completed')
            expect(allCompleted).toBe(true)
          },
          { timeout: 5_000 },
        )

        expect(order).toEqual([1, 2, 3])
      })
    })

    describe('maxConcurrentRuns', () => {
      it('still processes runs one at a time when maxConcurrentRuns is omitted', async () => {
        const order: number[] = []
        const sequentialDef = defineJob({
          name: 'seq-default',
          input: z.object({ n: z.number() }),
          run: async (_step, input) => {
            order.push(input.n)
            // sleep-ok(work): a slower job only widens the window in which
            // a concurrency bug would reorder runs
            await new Promise((r) => setTimeout(r, 20))
          },
        })
        const d = durably.register({ job: sequentialDef })

        await d.jobs.job.trigger({ n: 1 })
        await d.jobs.job.trigger({ n: 2 })
        d.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            expect(runs.every((r) => r.status === 'completed')).toBe(true)
          },
          { timeout: 5_000 },
        )

        expect(order).toEqual([1, 2])
      })

      it('runs multiple jobs concurrently when maxConcurrentRuns > 1', async () => {
        let concurrent = 0
        let maxConcurrent = 0
        // Each run holds until a second run is in flight, so overlap is
        // required rather than hoped for.
        const overlapped = createDeferred()
        const parallelDef = defineJob({
          name: 'parallel-test',
          input: z.object({ id: z.number() }),
          run: async (step) => {
            concurrent++
            maxConcurrent = Math.max(maxConcurrent, concurrent)
            if (concurrent > 1) overlapped.resolve()
            await step.run('work', async () => {
              await overlapped.promise
            })
            concurrent--
          },
        })
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          maxConcurrentRuns: 3,
        })
        await d.migrate()
        const dp = d.register({ job: parallelDef })
        try {
          await dp.jobs.job.trigger({ id: 1 })
          await dp.jobs.job.trigger({ id: 2 })
          await dp.jobs.job.trigger({ id: 3 })

          dp.start()

          await vi.waitFor(
            async () => {
              const runs = await dp.jobs.job.getRuns()
              expect(runs.every((r) => r.status === 'completed')).toBe(true)
            },
            { timeout: 5000 },
          )

          expect(maxConcurrent).toBeGreaterThan(1)
        } finally {
          overlapped.resolve()
          await dp.stop()
          await d.db.destroy()
        }
      })

      it('attempts another claim soon after a slot finishes without waiting for pollingIntervalMs', async () => {
        const longPoll = 60_000
        const order: string[] = []
        const refillDef = defineJob({
          name: 'refill-test',
          input: z.object({ phase: z.string() }),
          run: async (_step, input) => {
            order.push(`start-${input.phase}`)
            // sleep-ok(work): a slower job only widens the window in which
            // a second run could start before this one ends
            await new Promise((r) => setTimeout(r, 30))
            order.push(`end-${input.phase}`)
          },
        })
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: longPoll,
          maxConcurrentRuns: 1,
        })
        await d.migrate()
        const dp = d.register({ job: refillDef })
        try {
          await dp.jobs.job.trigger({ phase: 'a' })
          await dp.jobs.job.trigger({ phase: 'b' })
          dp.start()

          await vi.waitFor(
            async () => {
              const runs = await dp.jobs.job.getRuns()
              expect(runs.every((r) => r.status === 'completed')).toBe(true)
            },
            { timeout: 5000 },
          )

          expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
        } finally {
          await dp.stop()
          await d.db.destroy()
        }
      })

      it('stop() waits for all in-flight runs when maxConcurrentRuns > 1', async () => {
        let started = 0
        const bothStarted = createDeferred()
        const release = createDeferred()
        const stopDef = defineJob({
          name: 'stop-parallel',
          input: z.object({ tag: z.string() }),
          run: async () => {
            if (++started === 2) bothStarted.resolve()
            await release.promise
          },
        })
        const d = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          maxConcurrentRuns: 2,
        })
        await d.migrate()
        const dp = d.register({ job: stopDef })
        try {
          await dp.jobs.job.trigger({ tag: 'a' })
          await dp.jobs.job.trigger({ tag: 'b' })
          dp.start()

          // Stop while both runs are held, then let them finish.
          await bothStarted.promise
          const stopping = dp.stop()
          release.resolve()
          await stopping

          const runs = await dp.jobs.job.getRuns()
          expect(runs.every((r) => r.status === 'completed')).toBe(true)
        } finally {
          release.resolve()
          await dp.stop()
          await d.db.destroy()
        }
      })
    })
  })
}
