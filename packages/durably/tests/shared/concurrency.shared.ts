import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably } from '../../src'

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

      const job = durably.defineJob(
        {
          name: 'concurrency-test',
          input: z.object({ id: z.string() }),
        },
        async (ctx, payload) => {
          executionOrder.push(`start-${payload.id}`)
          await ctx.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
          executionOrder.push(`end-${payload.id}`)
        },
      )

      // Trigger two runs with the same concurrency key
      await job.trigger({ id: '1' }, { concurrencyKey: 'user-123' })
      await job.trigger({ id: '2' }, { concurrencyKey: 'user-123' })

      durably.start()

      await vi.waitFor(
        async () => {
          const runs = await job.getRuns()
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

      const job = durably.defineJob(
        {
          name: 'different-keys-test',
          input: z.object({ id: z.string() }),
        },
        async (ctx, payload) => {
          startTimes[payload.id] = Date.now()
          await ctx.run('work', async () => {
            await new Promise((r) => setTimeout(r, 100))
          })
        },
      )

      // Trigger two runs with different concurrency keys
      await job.trigger({ id: 'a' }, { concurrencyKey: 'user-A' })
      await job.trigger({ id: 'b' }, { concurrencyKey: 'user-B' })

      durably.start()

      await vi.waitFor(
        async () => {
          const runs = await job.getRuns()
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

      const job = durably.defineJob(
        {
          name: 'no-key-test',
          input: z.object({ id: z.string() }),
        },
        async (ctx, payload) => {
          executionOrder.push(payload.id)
          await ctx.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
        },
      )

      // Mix of runs with and without concurrency keys
      await job.trigger({ id: '1' }) // no key
      await job.trigger({ id: '2' }, { concurrencyKey: 'key-x' })
      await job.trigger({ id: '3' }) // no key

      durably.start()

      await vi.waitFor(
        async () => {
          const runs = await job.getRuns()
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

      const job = durably.defineJob(
        {
          name: 'null-key-test',
          input: z.object({ id: z.number() }),
        },
        async (ctx) => {
          concurrentRuns++
          maxConcurrent = Math.max(maxConcurrent, concurrentRuns)
          await ctx.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
          concurrentRuns--
        },
      )

      // Multiple runs with no concurrency key
      await job.trigger({ id: 1 })
      await job.trigger({ id: 2 })
      await job.trigger({ id: 3 })

      durably.start()

      await vi.waitFor(
        async () => {
          const runs = await job.getRuns()
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
