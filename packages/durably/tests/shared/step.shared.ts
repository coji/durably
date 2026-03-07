import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  defineJob,
  type Durably,
  type RunProgressEvent,
  type StepCancelEvent,
  type StepCompleteEvent,
  type StepFailEvent,
} from '../../src'

export function createStepTests(createDialect: () => Dialect) {
  describe('step.run() Step Execution', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
        cleanupSteps: false,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    it('executes step function and returns result', async () => {
      const stepReturnTestDef = defineJob({
        name: 'step-return-test',
        input: z.object({}),
        output: z.object({ result: z.number() }),
        run: async (step) => {
          const value = await step.run('compute', () => 42)
          return { result: value }
        },
      })
      const d = durably.register({ job: stepReturnTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          expect(updated?.output).toEqual({ result: 42 })
        },
        { timeout: 1000 },
      )
    })

    it('records step in steps table on success', async () => {
      const stepRecordTestDef = defineJob({
        name: 'step-record-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('step1', () => 'result1')
          await step.run('step2', () => 'result2')
        },
      })
      const d = durably.register({ job: stepRecordTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const steps = await d.storage.getSteps(run.id)
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

    it('deletes persisted steps after terminal runs by default', async () => {
      const cleanupDurably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
      })
      await cleanupDurably.migrate()

      try {
        const cleanupTestDef = defineJob({
          name: 'step-cleanup-test',
          input: z.object({}),
          run: async (step) => {
            await step.run('step1', () => 'result1')
            await step.run('step2', () => 'result2')
          },
        })
        const d = cleanupDurably.register({ job: cleanupTestDef })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        expect(await d.storage.getSteps(run.id)).toHaveLength(0)
      } finally {
        await cleanupDurably.stop()
        await cleanupDurably.db.destroy()
      }
    })

    it('transitions run to failed when step throws', async () => {
      const stepFailTestDef = defineJob({
        name: 'step-fail-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('failing-step', () => {
            throw new Error('Step failed!')
          })
        },
      })
      const d = durably.register({ job: stepFailTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('failed')
          expect(updated?.error).toContain('Step failed!')
        },
        { timeout: 1000 },
      )

      // Check step was recorded as failed
      const steps = await d.storage.getSteps(run.id)
      expect(steps).toHaveLength(1)
      expect(steps[0].status).toBe('failed')
      expect(steps[0].error).toContain('Step failed!')
    })

    it('skips completed steps on resume', async () => {
      let step1Calls = 0
      let step2Calls = 0

      const stepResumeTestDef = defineJob({
        name: 'step-resume-test',
        input: z.object({ shouldFail: z.boolean() }),
        run: async (step, input) => {
          await step.run('step1', () => {
            step1Calls++
            return 'step1-result'
          })

          await step.run('step2', () => {
            step2Calls++
            if (input.shouldFail && step2Calls === 1) {
              throw new Error('Intentional failure')
            }
            return 'step2-result'
          })
        },
      })
      const d = durably.register({ job: stepResumeTestDef })

      // First run - will fail at step2
      const run1 = await d.jobs.job.trigger({ shouldFail: true })
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run1.id)
          expect(updated?.status).toBe('failed')
        },
        { timeout: 1000 },
      )

      expect(step1Calls).toBe(1)
      expect(step2Calls).toBe(1)

      // Reset run to pending (simulating internal state rewind)
      await d.storage.updateRun(run1.id, { status: 'pending' })

      // Second run - step1 should be skipped
      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run1.id)
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

      const stepOutputResumeTestDef = defineJob({
        name: 'step-output-resume-test',
        input: z.object({}),
        output: z.object({ step1Result: z.string() }),
        run: async (step) => {
          // step1 computes a unique value each time it's called
          const result = await step.run('step1', () => {
            step1CallCount++
            return `computed-call-${step1CallCount}`
          })

          // step2 fails on first attempt
          await step.run('step2', () => {
            if (step2CallCount === 0) {
              step2CallCount++
              throw new Error('First attempt failure')
            }
            step2CallCount++
          })

          return { step1Result: result }
        },
      })
      const d = durably.register({ job: stepOutputResumeTestDef })

      // First attempt - step1 succeeds, step2 fails
      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('failed')
        },
        { timeout: 1000 },
      )

      expect(step1CallCount).toBe(1)
      expect(step2CallCount).toBe(1)

      // Retry - step1 should be skipped and return stored value
      await d.storage.updateRun(run.id, {
        status: 'pending',
      })

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
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

      const stepEventsTestDef = defineJob({
        name: 'step-events-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('myStep', () => 'hello')
        },
      })
      const d = durably.register({ job: stepEventsTestDef })

      await d.jobs.job.trigger({})
      d.start()

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
      const asyncStepTestDef = defineJob({
        name: 'async-step-test',
        input: z.object({}),
        output: z.object({ value: z.string() }),
        run: async (step) => {
          const value = await step.run('async-step', async () => {
            await new Promise((r) => setTimeout(r, 50))
            return 'async-result'
          })
          return { value }
        },
      })
      const d = durably.register({ job: asyncStepTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          expect(updated?.output).toEqual({ value: 'async-result' })
        },
        { timeout: 1000 },
      )
    })

    it('records step started_at before execution and completed_at after', async () => {
      const stepTimingTestDef = defineJob({
        name: 'step-timing-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('slow-step', async () => {
            await new Promise((r) => setTimeout(r, 100))
            return 'done'
          })
        },
      })
      const d = durably.register({ job: stepTimingTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('completed')
        },
        { timeout: 1000 },
      )

      const steps = await d.storage.getSteps(run.id)
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

    it('emits run:progress event when step.progress() is called', async () => {
      const progressEvents: RunProgressEvent[] = []

      durably.on('run:progress', (e) => progressEvents.push(e))

      const progressTestDef = defineJob({
        name: 'progress-test',
        input: z.object({}),
        run: async (step) => {
          step.progress(1, 3, 'Step 1 of 3')
          await step.run('step1', () => 'done')
          step.progress(2, 3, 'Step 2 of 3')
          await step.run('step2', () => 'done')
          step.progress(3, 3, 'Complete')
        },
      })
      const d = durably.register({ job: progressTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('completed')
        },
        { timeout: 1000 },
      )

      expect(progressEvents).toHaveLength(3)
      expect(progressEvents[0]).toMatchObject({
        type: 'run:progress',
        runId: run.id,
        jobName: 'progress-test',
        progress: { current: 1, total: 3, message: 'Step 1 of 3' },
      })
      expect(progressEvents[1]).toMatchObject({
        type: 'run:progress',
        runId: run.id,
        jobName: 'progress-test',
        progress: { current: 2, total: 3, message: 'Step 2 of 3' },
      })
      expect(progressEvents[2]).toMatchObject({
        type: 'run:progress',
        runId: run.id,
        jobName: 'progress-test',
        progress: { current: 3, total: 3, message: 'Complete' },
      })
    })

    it('passes AbortSignal to step callback that starts as not aborted', async () => {
      let receivedSignal: AbortSignal | null = null

      const signalTestDef = defineJob({
        name: 'signal-test',
        input: z.object({}),
        output: z.object({ aborted: z.boolean() }),
        run: async (step) => {
          const aborted = await step.run('check-signal', (signal) => {
            receivedSignal = signal
            return signal.aborted
          })
          return { aborted }
        },
      })
      const d = durably.register({ job: signalTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('completed')
          expect(updated?.output).toEqual({ aborted: false })
        },
        { timeout: 1000 },
      )

      expect(receivedSignal).toBeInstanceOf(AbortSignal)
      expect(receivedSignal!.aborted).toBe(false)
    })

    it('aborts signal when run is cancelled during a long-running step', async () => {
      let signalAbortedDuringStep = false
      let stepStartedResolve!: () => void
      const stepStartedPromise = new Promise<void>((resolve) => {
        stepStartedResolve = resolve
      })

      const signalCancelTestDef = defineJob({
        name: 'signal-cancel-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('long-step', async (signal) => {
            stepStartedResolve()
            // Simulate long-running work that checks signal
            await new Promise<void>((resolve) => {
              const check = () => {
                if (signal.aborted) {
                  signalAbortedDuringStep = true
                  resolve()
                  return
                }
                setTimeout(check, 10)
              }
              check()
            })
          })
        },
      })
      const d = durably.register({ job: signalCancelTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      // Wait for step to actually start executing
      await stepStartedPromise

      // Cancel the run while step is executing
      await d.cancel(run.id)

      // Wait for the signal to be aborted inside the step
      await vi.waitFor(
        () => {
          expect(signalAbortedDuringStep).toBe(true)
        },
        { timeout: 2000 },
      )
    })

    it('emits step:cancel event when step is cancelled', async () => {
      const cancelEvents: StepCancelEvent[] = []
      const failEvents: StepFailEvent[] = []
      let stepStartedResolve!: () => void
      const stepStartedPromise = new Promise<void>((resolve) => {
        stepStartedResolve = resolve
      })

      const stepCancelEventDef = defineJob({
        name: 'step-cancel-event-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('cancellable-step', async (signal) => {
            stepStartedResolve()
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                reject(
                  new DOMException('The operation was aborted.', 'AbortError'),
                )
              })
            })
          })
        },
      })
      const d = durably.register({ job: stepCancelEventDef })

      d.on('step:cancel', (event) => cancelEvents.push(event))
      d.on('step:fail', (event) => failEvents.push(event))

      const run = await d.jobs.job.trigger({})
      d.start()

      await stepStartedPromise
      await d.cancel(run.id)

      await vi.waitFor(
        () => {
          expect(cancelEvents).toHaveLength(1)
        },
        { timeout: 2000 },
      )

      expect(cancelEvents[0].stepName).toBe('cancellable-step')
      expect(cancelEvents[0].runId).toBe(run.id)
      expect(failEvents).toHaveLength(0)
    })

    it('emits step:fail event for non-cancellation errors', async () => {
      const cancelEvents: StepCancelEvent[] = []
      const failEvents: StepFailEvent[] = []

      const stepFailEventDef = defineJob({
        name: 'step-fail-event-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('failing-step', async () => {
            throw new Error('intentional error')
          })
        },
      })
      const d = durably.register({ job: stepFailEventDef })

      d.on('step:cancel', (event) => cancelEvents.push(event))
      d.on('step:fail', (event) => failEvents.push(event))

      await d.jobs.job.trigger({})
      d.start()

      await vi.waitFor(
        () => {
          expect(failEvents).toHaveLength(1)
        },
        { timeout: 2000 },
      )

      expect(failEvents[0].stepName).toBe('failing-step')
      expect(failEvents[0].error).toBe('intentional error')
      expect(cancelEvents).toHaveLength(0)
    })

    it('signal is aborted when cancellation is detected at step boundary', async () => {
      let step2Called = false
      let step1StartedResolve!: () => void
      const step1StartedPromise = new Promise<void>((resolve) => {
        step1StartedResolve = resolve
      })
      let proceedResolve!: () => void
      const proceedPromise = new Promise<void>((resolve) => {
        proceedResolve = resolve
      })

      let step1SignalAborted = false

      const signalBoundaryTestDef = defineJob({
        name: 'signal-boundary-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('step1', async (signal) => {
            step1StartedResolve()
            // Wait until we are told to proceed (after cancel is issued)
            await proceedPromise
            step1SignalAborted = signal.aborted
            return 'done'
          })

          // This step should not execute because cancellation is detected
          await step.run('step2', () => {
            step2Called = true
            return 'should-not-reach'
          })
        },
      })
      const d = durably.register({ job: signalBoundaryTestDef })

      const run = await d.jobs.job.trigger({})
      d.start()

      // Wait for step1 to start
      await step1StartedPromise

      // Cancel the run while step1 is still executing
      await d.cancel(run.id)

      // Now let step1 complete - the next step boundary check should detect cancellation
      proceedResolve()

      // Wait for the run to settle
      await vi.waitFor(
        async () => {
          const updated = await d.jobs.job.getRun(run.id)
          expect(updated?.status).toBe('cancelled')
        },
        { timeout: 2000 },
      )

      // step2 callback should never have been called
      expect(step2Called).toBe(false)
      // signal should have been aborted during step1
      expect(step1SignalAborted).toBe(true)
    })
  })
}
