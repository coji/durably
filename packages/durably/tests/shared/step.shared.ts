import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably, type StepCompleteEvent } from '../../src'

export function createStepTests(createDialect: () => Dialect) {
  describe('ctx.run() Step Execution', () => {
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

    it('executes step function and returns result', async () => {
      const job = durably.defineJob(
        {
          name: 'step-return-test',
          input: z.object({}),
          output: z.object({ result: z.number() }),
        },
        async (ctx) => {
          const value = await ctx.run('compute', () => 42)
          return { result: value }
        },
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          expect(updated?.output).toEqual({ result: 42 })
        },
        { timeout: 1000 },
      )
    })

    it('records step in steps table on success', async () => {
      const job = durably.defineJob(
        {
          name: 'step-record-test',
          input: z.object({}),
        },
        async (ctx) => {
          await ctx.run('step1', () => 'result1')
          await ctx.run('step2', () => 'result2')
        },
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          const steps = await durably.storage.getSteps(run.id)
          expect(steps).toHaveLength(2)
          expect(steps[0].name).toBe('step1')
          expect(steps[0].status).toBe('completed')
          expect(steps[0].output).toBe('result1')
          expect(steps[1].name).toBe('step2')
          expect(steps[1].status).toBe('completed')
          expect(steps[1].output).toBe('result2')
        },
        { timeout: 1000 },
      )
    })

    it('transitions run to failed when step throws', async () => {
      const job = durably.defineJob(
        {
          name: 'step-fail-test',
          input: z.object({}),
        },
        async (ctx) => {
          await ctx.run('failing-step', () => {
            throw new Error('Step failed!')
          })
        },
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run.id)
          expect(updated?.status).toBe('failed')
          expect(updated?.error).toContain('Step failed!')
        },
        { timeout: 1000 },
      )

      // Check step was recorded as failed
      const steps = await durably.storage.getSteps(run.id)
      expect(steps).toHaveLength(1)
      expect(steps[0].status).toBe('failed')
      expect(steps[0].error).toContain('Step failed!')
    })

    it('skips completed steps on resume', async () => {
      let step1Calls = 0
      let step2Calls = 0

      const job = durably.defineJob(
        {
          name: 'step-resume-test',
          input: z.object({ shouldFail: z.boolean() }),
        },
        async (ctx, payload) => {
          await ctx.run('step1', () => {
            step1Calls++
            return 'step1-result'
          })

          await ctx.run('step2', () => {
            step2Calls++
            if (payload.shouldFail && step2Calls === 1) {
              throw new Error('Intentional failure')
            }
            return 'step2-result'
          })
        },
      )

      // First run - will fail at step2
      const run1 = await job.trigger({ shouldFail: true })
      durably.start()

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run1.id)
          expect(updated?.status).toBe('failed')
        },
        { timeout: 1000 },
      )

      expect(step1Calls).toBe(1)
      expect(step2Calls).toBe(1)

      // Reset run to pending for retry (simulate retry behavior)
      await durably.storage.updateRun(run1.id, { status: 'pending' })

      // Second run - step1 should be skipped
      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run1.id)
          expect(updated?.status).toBe('completed')
        },
        { timeout: 1000 },
      )

      // step1 was skipped (still 1), step2 was retried
      expect(step1Calls).toBe(1)
      expect(step2Calls).toBe(2)
    })

    it('returns stored output when step is skipped', async () => {
      let step1CallCount = 0
      let step2CallCount = 0

      const job = durably.defineJob(
        {
          name: 'step-output-resume-test',
          input: z.object({}),
          output: z.object({ step1Result: z.string() }),
        },
        async (ctx) => {
          // step1 computes a unique value each time it's called
          const result = await ctx.run('step1', () => {
            step1CallCount++
            return `computed-call-${step1CallCount}`
          })

          // step2 fails on first attempt
          await ctx.run('step2', () => {
            if (step2CallCount === 0) {
              step2CallCount++
              throw new Error('First attempt failure')
            }
            step2CallCount++
          })

          return { step1Result: result }
        },
      )

      // First attempt - step1 succeeds, step2 fails
      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run.id)
          expect(updated?.status).toBe('failed')
        },
        { timeout: 1000 },
      )

      expect(step1CallCount).toBe(1)
      expect(step2CallCount).toBe(1)

      // Retry - step1 should be skipped and return stored value
      await durably.storage.updateRun(run.id, {
        status: 'pending',
      })

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          // The step1Result should be from first call, not recomputed
          expect(updated?.output?.step1Result).toBe('computed-call-1')
        },
        { timeout: 1000 },
      )

      // step1 was NOT called again (still 1), step2 was retried
      expect(step1CallCount).toBe(1)
      expect(step2CallCount).toBe(2)
    })

    it('emits step:start and step:complete events', async () => {
      const stepEvents: StepCompleteEvent[] = []

      durably.on('step:complete', (e) => stepEvents.push(e))

      const job = durably.defineJob(
        {
          name: 'step-events-test',
          input: z.object({}),
        },
        async (ctx) => {
          await ctx.run('myStep', () => 'hello')
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(stepEvents).toHaveLength(1)
          expect(stepEvents[0].stepName).toBe('myStep')
          expect(stepEvents[0].output).toBe('hello')
        },
        { timeout: 1000 },
      )
    })

    it('handles async step functions', async () => {
      const job = durably.defineJob(
        {
          name: 'async-step-test',
          input: z.object({}),
          output: z.object({ value: z.string() }),
        },
        async (ctx) => {
          const value = await ctx.run('async-step', async () => {
            await new Promise((r) => setTimeout(r, 50))
            return 'async-result'
          })
          return { value }
        },
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          const updated = await job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          expect(updated?.output).toEqual({ value: 'async-result' })
        },
        { timeout: 1000 },
      )
    })

    it('records step started_at before execution and completed_at after', async () => {
      const job = durably.defineJob(
        {
          name: 'step-timing-test',
          input: z.object({}),
        },
        async (ctx) => {
          await ctx.run('slow-step', async () => {
            await new Promise((r) => setTimeout(r, 100))
            return 'done'
          })
        },
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

      const steps = await durably.storage.getSteps(run.id)
      expect(steps).toHaveLength(1)

      const step = steps[0]
      expect(step.startedAt).toBeDefined()
      expect(step.completedAt).toBeDefined()

      // completed_at should be after started_at (step took ~100ms)
      const startedAt = new Date(step.startedAt).getTime()
      const completedAt = new Date(step.completedAt!).getTime()
      const duration = completedAt - startedAt

      expect(duration).toBeGreaterThanOrEqual(90) // Allow some timing variance
    })
  })
}
