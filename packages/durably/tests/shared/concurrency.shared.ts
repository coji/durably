import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'

export function createConcurrencyTests(createDialect: () => Dialect) {
  describe('concurrencyKey Serialization', () => {
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

    it('excludes runs with same concurrencyKey when one is running', async () => {
      const executionOrder: string[] = []

      const concurrencyTestDef = defineJob({
        name: 'concurrency-test',
        input: z.object({ id: z.string() }),
        run: async (step, input) => {
          executionOrder.push(`start-${input.id}`)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
          executionOrder.push(`end-${input.id}`)
        },
      })
      const d = durably.register({ job: concurrencyTestDef })

      const first = await d.jobs.job.trigger(
        { id: '1' },
        { concurrencyKey: 'user-123' },
      )
      d.start()

      await vi.waitFor(
        async () => {
          const run = await d.jobs.job.getRun(first.id)
          return run?.status === 'leased'
        },
        { timeout: 2000 },
      )

      const second = await d.jobs.job.trigger(
        { id: '2' },
        { concurrencyKey: 'user-123' },
      )

      const firstWhileSecondQueued = await d.jobs.job.getRun(first.id)
      const secondWhileBlocked = await d.jobs.job.getRun(second.id)
      expect(firstWhileSecondQueued?.status).toBe('leased')
      expect(secondWhileBlocked?.status).toBe('pending')

      await vi.waitFor(
        async () => {
          const runs = await d.jobs.job.getRuns()
          const allCompleted = runs.every((r) => r.status === 'completed')
          expect(allCompleted).toBe(true)
        },
        { timeout: 2000 },
      )

      // They should run sequentially: start-1, end-1, start-2, end-2
      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
    })

    it('allows runs with different concurrencyKeys to be fetched independently', async () => {
      const startTimes: Record<string, number> = {}

      const differentKeysTestDef = defineJob({
        name: 'different-keys-test',
        input: z.object({ id: z.string() }),
        run: async (step, input) => {
          startTimes[input.id] = Date.now()
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
        },
      })
      const d = durably.register({ job: differentKeysTestDef })

      // Trigger two runs with different concurrency keys
      await d.jobs.job.trigger({ id: 'a' }, { concurrencyKey: 'user-A' })
      await d.jobs.job.trigger({ id: 'b' }, { concurrencyKey: 'user-B' })

      d.start()

      await vi.waitFor(
        async () => {
          const runs = await d.jobs.job.getRuns()
          const allCompleted = runs.every((r) => r.status === 'completed')
          expect(allCompleted).toBe(true)
        },
        { timeout: 2000 },
      )

      expect(Object.keys(startTimes)).toHaveLength(2)
    })

    it('with maxConcurrentRuns > 1, different concurrencyKeys can run in parallel', async () => {
      let concurrent = 0
      let maxConcurrent = 0
      const parallelKeysDef = defineJob({
        name: 'parallel-keys-test',
        input: z.object({ id: z.string() }),
        run: async (step) => {
          concurrent++
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
          concurrent--
        },
      })
      const d = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        maxConcurrentRuns: 2,
      })
      await d.migrate()
      const dp = d.register({ job: parallelKeysDef })

      await dp.jobs.job.trigger({ id: 'a' }, { concurrencyKey: 'user-A' })
      await dp.jobs.job.trigger({ id: 'b' }, { concurrencyKey: 'user-B' })

      dp.start()

      await vi.waitFor(
        async () => {
          const runs = await dp.jobs.job.getRuns()
          expect(runs.every((r) => r.status === 'completed')).toBe(true)
        },
        { timeout: 3000 },
      )

      expect(maxConcurrent).toBe(2)
      await dp.stop()
      await d.db.destroy()
    })

    it('with maxConcurrentRuns > 1, identical concurrencyKey runs still never overlap', async () => {
      const executionOrder: string[] = []

      const sameKeyParallelDef = defineJob({
        name: 'same-key-parallel',
        input: z.object({ id: z.string() }),
        run: async (step, input) => {
          executionOrder.push(`start-${input.id}`)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 80))
          })
          executionOrder.push(`end-${input.id}`)
        },
      })
      const d = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        maxConcurrentRuns: 3,
      })
      await d.migrate()
      const dp = d.register({ job: sameKeyParallelDef })

      const first = await dp.jobs.job.trigger(
        { id: '1' },
        { concurrencyKey: 'user-123' },
      )
      dp.start()

      await vi.waitFor(
        async () => {
          const run = await dp.jobs.job.getRun(first.id)
          return run?.status === 'leased'
        },
        { timeout: 2000 },
      )

      const second = await dp.jobs.job.trigger(
        { id: '2' },
        { concurrencyKey: 'user-123' },
      )

      expect((await dp.jobs.job.getRun(second.id))?.status).toBe('pending')

      await vi.waitFor(
        async () => {
          const runs = await dp.jobs.job.getRuns()
          expect(runs.every((r) => r.status === 'completed')).toBe(true)
        },
        { timeout: 4000 },
      )

      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
      await dp.stop()
      await d.db.destroy()
    })

    it('runs without concurrencyKey are not blocked', async () => {
      const executionOrder: string[] = []

      const noKeyTestDef = defineJob({
        name: 'no-key-test',
        input: z.object({ id: z.string() }),
        run: async (step, input) => {
          executionOrder.push(input.id)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
        },
      })
      const d = durably.register({ job: noKeyTestDef })

      // Mix of runs with and without concurrency keys
      await d.jobs.job.trigger({ id: '1' }) // no key
      await d.jobs.job.trigger({ id: '2' }, { concurrencyKey: 'key-x' })
      await d.jobs.job.trigger({ id: '3' }) // no key

      d.start()

      await vi.waitFor(
        async () => {
          const runs = await d.jobs.job.getRuns()
          const allCompleted = runs.every((r) => r.status === 'completed')
          expect(allCompleted).toBe(true)
        },
        { timeout: 2000 },
      )

      expect(executionOrder).toHaveLength(3)
    })

    it('null concurrencyKey runs are independent', async () => {
      let concurrentRuns = 0
      let maxConcurrent = 0

      const nullKeyTestDef = defineJob({
        name: 'null-key-test',
        input: z.object({ id: z.number() }),
        run: async (step) => {
          concurrentRuns++
          maxConcurrent = Math.max(maxConcurrent, concurrentRuns)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
          concurrentRuns--
        },
      })
      const d = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        maxConcurrentRuns: 3,
      })
      await d.migrate()
      const dp = d.register({ job: nullKeyTestDef })

      await dp.jobs.job.trigger({ id: 1 })
      await dp.jobs.job.trigger({ id: 2 })
      await dp.jobs.job.trigger({ id: 3 })

      dp.start()

      await vi.waitFor(
        async () => {
          const runs = await dp.jobs.job.getRuns()
          const allCompleted = runs.every((r) => r.status === 'completed')
          expect(allCompleted).toBe(true)
        },
        { timeout: 3000 },
      )

      expect(maxConcurrent).toBeGreaterThan(1)
      await dp.stop()
      await d.db.destroy()
    })
  })
}
