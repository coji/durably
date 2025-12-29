import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'

export function createWorkerTests(createDialect: () => Dialect) {
  describe('Worker', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50, // Fast polling for tests
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
        const { job } = durably.register({ job: pollingTestDef })

        await job.trigger({})
        durably.start()

        // Wait for polling to pick up the job
        await vi.waitFor(
          async () => {
            const run = (await job.getRuns())[0]
            expect(run.status).toBe('completed')
          },
          { timeout: 1000 },
        )
      })

      it('stops after current run completes when stop() is called', async () => {
        let stepExecuted = false
        const stopTestDef = defineJob({
          name: 'stop-test',
          input: z.object({}),
          run: async (step) => {
            await step.run('step1', async () => {
              stepExecuted = true
              await new Promise((r) => setTimeout(r, 100))
            })
          },
        })
        const { job } = durably.register({ job: stopTestDef })

        await job.trigger({})
        durably.start()

        // Wait a bit then stop
        await new Promise((r) => setTimeout(r, 50))
        await durably.stop()

        expect(stepExecuted).toBe(true)
        const run = (await job.getRuns())[0]
        expect(run.status).toBe('completed')
      })

      it('stop() resolves immediately if no run is executing', async () => {
        durably.start()
        const startTime = Date.now()
        await durably.stop()
        const elapsed = Date.now() - startTime

        expect(elapsed).toBeLessThan(100)
      })
    })

    describe('Run state transitions', () => {
      it('transitions pending run to running then completed', async () => {
        const states: string[] = []

        durably.on('run:start', () => states.push('running'))
        durably.on('run:complete', () => states.push('completed'))

        const stateTestDef = defineJob({
          name: 'state-test',
          input: z.object({}),
          output: z.object({ value: z.number() }),
          run: async () => ({ value: 42 }),
        })
        const { job } = durably.register({ job: stateTestDef })

        const run = await job.trigger({})
        expect(run.status).toBe('pending')

        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        expect(states).toEqual(['running', 'completed'])
      })

      it('transitions to failed when job throws', async () => {
        const failTestDef = defineJob({
          name: 'fail-test',
          input: z.object({}),
          run: async () => {
            throw new Error('Job failed intentionally')
          },
        })
        const { job } = durably.register({ job: failTestDef })

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('failed')
            expect(updated?.error).toContain('Job failed intentionally')
          },
          { timeout: 1000 },
        )
      })
    })

    describe('Job execution', () => {
      it('passes payload to job function', async () => {
        let receivedPayload: unknown

        const payloadTestDef = defineJob({
          name: 'payload-test',
          input: z.object({ value: z.string() }),
          run: async (_step, payload) => {
            receivedPayload = payload
          },
        })
        const { job } = durably.register({ job: payloadTestDef })

        await job.trigger({ value: 'hello' })
        durably.start()

        await vi.waitFor(
          async () => {
            expect(receivedPayload).toEqual({ value: 'hello' })
          },
          { timeout: 1000 },
        )
      })

      it('stores output in completed run', async () => {
        const outputTestDef = defineJob({
          name: 'output-test',
          input: z.object({}),
          output: z.object({ result: z.number() }),
          run: async () => ({ result: 123 }),
        })
        const { job } = durably.register({ job: outputTestDef })

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
            expect(updated?.output).toEqual({ result: 123 })
          },
          { timeout: 1000 },
        )
      })

      it('processes multiple pending runs sequentially', async () => {
        const order: number[] = []

        const sequentialTestDef = defineJob({
          name: 'sequential-test',
          input: z.object({ n: z.number() }),
          run: async (_step, payload) => {
            order.push(payload.n)
            await new Promise((r) => setTimeout(r, 20))
          },
        })
        const { job } = durably.register({ job: sequentialTestDef })

        await job.trigger({ n: 1 })
        await job.trigger({ n: 2 })
        await job.trigger({ n: 3 })

        durably.start()

        await vi.waitFor(
          async () => {
            const runs = await job.getRuns()
            const allCompleted = runs.every((r) => r.status === 'completed')
            expect(allCompleted).toBe(true)
          },
          { timeout: 2000 },
        )

        expect(order).toEqual([1, 2, 3])
      })
    })
  })
}
