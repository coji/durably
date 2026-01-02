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
        pollingInterval: 50,
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
        run: async (step, payload) => {
          executionOrder.push(`start-${payload.id}`)
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
          executionOrder.push(`end-${payload.id}`)
        },
      })
      const d = durably.register({ job: concurrencyTestDef })

      // Trigger two runs with the same concurrency key
      await d.jobs.job.trigger({ id: '1' }, { concurrencyKey: 'user-123' })
      await d.jobs.job.trigger({ id: '2' }, { concurrencyKey: 'user-123' })

      d.start()

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
        run: async (step, payload) => {
          startTimes[payload.id] = Date.now()
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

      // Both jobs started - with single-threaded worker they still run sequentially
      // but the second one doesn't wait for the first to complete before being eligible
      expect(Object.keys(startTimes)).toHaveLength(2)
    })

    it('runs without concurrencyKey are not blocked', async () => {
      const executionOrder: string[] = []

      const noKeyTestDef = defineJob({
        name: 'no-key-test',
        input: z.object({ id: z.string() }),
        run: async (step, payload) => {
          executionOrder.push(payload.id)
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
      const d = durably.register({ job: nullKeyTestDef })

      // Multiple runs with no concurrency key
      await d.jobs.job.trigger({ id: 1 })
      await d.jobs.job.trigger({ id: 2 })
      await d.jobs.job.trigger({ id: 3 })

      d.start()

      await vi.waitFor(
        async () => {
          const runs = await d.jobs.job.getRuns()
          const allCompleted = runs.every((r) => r.status === 'completed')
          expect(allCompleted).toBe(true)
        },
        { timeout: 2000 },
      )

      // Single-threaded worker means maxConcurrent should be 1
      expect(maxConcurrent).toBe(1)
    })
  })
}
