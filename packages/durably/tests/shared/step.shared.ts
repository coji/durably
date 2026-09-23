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
  describe('step.all() parallel join', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        preserveSteps: true,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    it('runs branches concurrently, joins their results, and attributes logs', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started: string[] = []
      const logs: { stepName: string | null; message: string }[] = []
      durably.on('log:write', (event) => logs.push(event))

      const d = durably.register({
        job: defineJob({
          name: 'parallel-join',
          input: z.object({}),
          output: z.object({ first: z.number(), second: z.string() }),
          run: async (step) =>
            step.all({
              first: async (_signal, attempt) => {
                started.push('first')
                await gate
                attempt.log.info('first branch')
                step.log.info('ambiguous branch')
                return 1
              },
              second: async (_signal, attempt) => {
                started.push('second')
                await gate
                attempt.log.info('second branch')
                return 'two'
              },
            }),
        }),
      })

      const run = await d.jobs.job.trigger({})
      d.start()
      try {
        await vi.waitFor(() => expect(started).toHaveLength(2))
        expect((await d.jobs.job.getRun(run.id))?.status).toBe('leased')
      } finally {
        release()
      }

      await vi.waitFor(async () => {
        const updated = await d.jobs.job.getRun(run.id)
        expect(updated?.status).toBe('completed')
        expect(updated?.output).toEqual({ first: 1, second: 'two' })
      })
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepName: 'first',
            message: 'first branch',
          }),
          expect.objectContaining({
            stepName: 'second',
            message: 'second branch',
          }),
          expect.objectContaining({
            stepName: null,
            message: 'ambiguous branch',
          }),
        ]),
      )
      expect(
        (await d.storage.getStepAttempts(run.id)).map((a) => a.stepName),
      ).toEqual(expect.arrayContaining(['first', 'second']))
    })

    it('keeps shared logs attributed to an inner sequential step', async () => {
      const logs: { stepName: string | null; message: string }[] = []
      durably.on('log:write', (event) => logs.push(event))
      const d = durably.register({
        job: defineJob({
          name: 'nested-step-logs',
          input: z.object({}),
          run: async (step) => {
            await step.run('outer', async () => {
              await step.run('inner', () => {
                step.log.info('inner log')
              })
              step.log.info('outer log')
            })
          },
        }),
      })

      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.jobs.job.getRun(run.id))?.status).toBe('completed')
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stepName: 'inner', message: 'inner log' }),
          expect.objectContaining({ stepName: 'outer', message: 'outer log' }),
        ]),
      )
    })

    it('reuses a completed branch after lease recovery', async () => {
      let firstCalls = 0
      let secondCalls = 0
      const d = durably.register({
        job: defineJob({
          name: 'parallel-recovery',
          input: z.object({}),
          output: z.object({ first: z.string(), second: z.string() }),
          run: async (step) =>
            step.all({
              first: () => {
                firstCalls++
                return 'first result'
              },
              second: () => {
                secondCalls++
                return 'second result'
              },
            }),
        }),
      })

      const run = await d.jobs.job.trigger({})
      const claimed = await d.storage.claimNext(
        'old-worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed).not.toBeNull()
      await d.storage.persistStep(run.id, claimed!.leaseGeneration, {
        name: 'first',
        index: 0,
        status: 'completed',
        output: 'first result',
        startedAt: new Date().toISOString(),
      })
      await d.storage.updateRun(run.id, {
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      })

      d.start()
      await vi.waitFor(async () => {
        const updated = await d.jobs.job.getRun(run.id)
        expect(updated?.status).toBe('completed')
        expect(updated?.output).toEqual({
          first: 'first result',
          second: 'second result',
        })
      })
      expect(firstCalls).toBe(0)
      expect(secondCalls).toBe(1)
    })

    it('waits for sibling records before failing the run', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let siblingStarted = false
      const d = durably.register({
        job: defineJob({
          name: 'parallel-failure',
          input: z.object({}),
          run: async (step) => {
            await step.all({
              failing: async () => {
                await vi.waitFor(() => expect(siblingStarted).toBe(true))
                throw new Error('review failed')
              },
              sibling: async () => {
                siblingStarted = true
                await gate
                return 'saved result'
              },
            })
          },
        }),
      })

      const run = await d.jobs.job.trigger({})
      d.start()
      try {
        await vi.waitFor(async () => {
          const attempts = await d.storage.getStepAttempts(run.id)
          expect(attempts.find((a) => a.stepName === 'failing')?.status).toBe(
            'failed',
          )
        })
        expect((await d.jobs.job.getRun(run.id))?.status).toBe('leased')
      } finally {
        release()
      }

      await vi.waitFor(async () => {
        const updated = await d.jobs.job.getRun(run.id)
        expect(updated?.status).toBe('failed')
        expect(updated?.error).toContain('review failed')
      })
      expect(await d.storage.getCompletedStep(run.id, 'sibling')).toMatchObject(
        { output: 'saved result' },
      )
    })

    it('keeps a successful sibling result after failure with default options', async () => {
      const defaultDurably = createDurably({ dialect: createDialect() })
      await defaultDurably.migrate()
      try {
        const d = defaultDurably.register({
          job: defineJob({
            name: 'parallel-default-retention',
            input: z.object({}),
            run: async (step) => {
              await step.all({
                failing: () => {
                  throw new Error('failed branch')
                },
                successful: () => 'saved result',
              })
            },
          }),
        })
        const run = await d.jobs.job.trigger({})
        await d.processOne()
        expect((await d.jobs.job.getRun(run.id))?.status).toBe('failed')
        expect(
          await d.storage.getCompletedStep(run.id, 'successful'),
        ).toMatchObject({ output: 'saved result' })
      } finally {
        await defaultDurably.stop()
        await defaultDurably.db.destroy()
      }
    })

    it('pairs run:fail error with the failed branch name when indexes differ from declaration order', async () => {
      let releaseFirst!: () => void
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const failures: { error: string; failedStepName: string }[] = []
      durably.on('run:fail', (event) => failures.push(event))
      const d = durably.register({
        job: defineJob({
          name: 'parallel-failure-order',
          input: z.object({}),
          run: async (step) => {
            await step.all({
              first: () => {
                throw new Error('first error')
              },
              second: () => {
                throw new Error('second error')
              },
            })
          },
        }),
      })
      const originalGetCompletedStep = d.storage.getCompletedStep
      d.storage.getCompletedStep = async (runId, name) => {
        if (name === 'first') await firstGate
        return originalGetCompletedStep(runId, name)
      }

      const run = await d.jobs.job.trigger({})
      d.start()
      try {
        await vi.waitFor(async () => {
          const attempts = await d.storage.getStepAttempts(run.id)
          expect(attempts.find((a) => a.stepName === 'second')?.status).toBe(
            'failed',
          )
        })
      } finally {
        releaseFirst()
        d.storage.getCompletedStep = originalGetCompletedStep
      }

      await vi.waitFor(async () => {
        expect((await d.jobs.job.getRun(run.id))?.status).toBe('failed')
      })
      expect(failures).toEqual([
        expect.objectContaining({
          error: 'second error',
          failedStepName: 'second',
        }),
      ])
    })

    it('attributes a recovered failure to the current branch, not an older failed checkpoint', async () => {
      const failures: { error: string; failedStepName: string }[] = []
      durably.on('run:fail', (event) => failures.push(event))
      const d = durably.register({
        job: defineJob({
          name: 'parallel-recovered-failure',
          input: z.object({}),
          run: async (step) => {
            await step.all({
              first: () => 'recovered successfully',
              second: () => {
                throw new Error('current branch failed')
              },
            })
          },
        }),
      })

      const run = await d.jobs.job.trigger({})
      const oldLease = await d.storage.claimNext(
        'old-worker',
        new Date().toISOString(),
        30_000,
      )
      expect(oldLease).not.toBeNull()
      await d.storage.persistStep(run.id, oldLease!.leaseGeneration, {
        name: 'first',
        index: 0,
        status: 'failed',
        error: 'old branch failure',
        startedAt: new Date().toISOString(),
      })
      await d.storage.updateRun(run.id, {
        leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      })

      d.start()
      await vi.waitFor(async () => {
        expect((await d.jobs.job.getRun(run.id))?.status).toBe('failed')
      })
      expect(failures).toEqual([
        expect.objectContaining({
          error: 'current branch failed',
          failedStepName: 'second',
        }),
      ])
    })

    it('preserves cancellation when another branch has already failed', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const workerErrors: string[] = []
      durably.on('worker:error', (event) => workerErrors.push(event.error))
      const d = durably.register({
        job: defineJob({
          name: 'parallel-cancel',
          input: z.object({}),
          run: async (step) => {
            await step.all({
              failing: () => {
                throw new Error('ordinary branch failure')
              },
              waiting: async () => {
                await gate
                return 'late result'
              },
            })
          },
        }),
      })

      const run = await d.jobs.job.trigger({})
      const processing = d.processOne()
      try {
        await vi.waitFor(async () => {
          const attempts = await d.storage.getStepAttempts(run.id)
          expect(attempts.find((a) => a.stepName === 'failing')?.status).toBe(
            'failed',
          )
          expect(attempts.some((a) => a.stepName === 'waiting')).toBe(true)
        })
        await d.cancel(run.id)
      } finally {
        release()
      }
      await processing

      expect((await d.jobs.job.getRun(run.id))?.status).toBe('cancelled')
      expect(workerErrors).toEqual([])
    })

    it('preserves lease loss when another branch has already failed', async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const d = durably.register({
        job: defineJob({
          name: 'parallel-lease-loss',
          input: z.object({}),
          run: async (step) => {
            await step.all({
              failing: () => {
                throw new Error('ordinary branch failure')
              },
              waiting: async () => {
                await gate
                return 'late result'
              },
            })
          },
        }),
      })

      const run = await d.jobs.job.trigger({})
      const processing = d.processOne()
      try {
        await vi.waitFor(async () => {
          const attempts = await d.storage.getStepAttempts(run.id)
          expect(attempts.find((a) => a.stepName === 'failing')?.status).toBe(
            'failed',
          )
          expect(attempts.some((a) => a.stepName === 'waiting')).toBe(true)
        })
        await d.storage.updateRun(run.id, {
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        })
      } finally {
        release()
      }
      await processing

      expect((await d.jobs.job.getRun(run.id))?.status).toBe('leased')
    })
  })

  describe('step.run() Step Execution', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        preserveSteps: true,
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
      )
    })

    it('deletes steps after terminal runs by default', async () => {
      const defaultDurably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
      })
      await defaultDurably.migrate()

      try {
        const cleanupTestDef = defineJob({
          name: 'step-cleanup-default-test',
          input: z.object({}),
          run: async (step) => {
            await step.run('step1', () => 'result1')
            await step.run('step2', () => 'result2')
          },
        })
        const d = defaultDurably.register({ job: cleanupTestDef })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
            expect(await d.storage.getSteps(run.id)).toHaveLength(0)
          },
          { timeout: 5_000 },
        )
      } finally {
        await defaultDurably.stop()
        await defaultDurably.db.destroy()
      }
    })

    it('deletes persisted steps after terminal runs when preserveSteps is false', async () => {
      const cleanupDurably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        preserveSteps: false,
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
            expect(await d.storage.getSteps(run.id)).toHaveLength(0)
          },
          { timeout: 5_000 },
        )
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
      )
    })

    it('handles async step functions', async () => {
      const asyncStepTestDef = defineJob({
        name: 'async-step-test',
        input: z.object({}),
        output: z.object({ value: z.string() }),
        run: async (step) => {
          const value = await step.run('async-step', async () => {
            // sleep-ok(work): makes the step genuinely async; the test waits
            // for completion however long it takes
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
        { timeout: 5_000 },
      )
    })

    it('records step started_at before execution and completed_at after', async () => {
      const stepTimingTestDef = defineJob({
        name: 'step-timing-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('slow-step', async () => {
            // sleep-ok(clock): the test asserts the recorded duration is at
            // least 90ms; a slow runner only makes the step take longer
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
                // sleep-ok(poll): re-checks the signal until it is aborted
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
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
        { timeout: 5_000 },
      )

      // step2 callback should never have been called
      expect(step2Called).toBe(false)
      // signal should have been aborted during step1
      expect(step1SignalAborted).toBe(true)
    })

    it('does not persist completed step after run is cancelled (race condition)', async () => {
      let stepFnCompletedResolve!: () => void
      const stepFnCompleted = new Promise<void>((r) => {
        stepFnCompletedResolve = r
      })
      let cancelDoneResolve!: () => void
      const cancelDone = new Promise<void>((r) => {
        cancelDoneResolve = r
      })

      const raceDef = defineJob({
        name: 'cancel-race-test',
        input: z.object({}),
        run: async (step) => {
          await step.run('race-step', async () => {
            stepFnCompletedResolve()
            await cancelDone
            return 'should-not-be-persisted'
          })
        },
      })

      const d = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        preserveSteps: true,
      }).register({ raceDef })
      await d.migrate()
      d.start()

      const run = await d.jobs.raceDef.trigger({})

      await stepFnCompleted

      // Cancel via direct DB update to simulate external cancel (no abort signal).
      // This bypasses the in-process event emitter so throwIfAborted() won't fire,
      // forcing the test to exercise the DB-level status='leased' guard in persistStep.
      await d.db
        .updateTable('durably_runs')
        .set({
          status: 'cancelled',
          lease_owner: null,
          lease_expires_at: null,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', run.id)
        .execute()

      // Let fn() return — persistStep will attempt to write but DB guard rejects it
      cancelDoneResolve()

      // Wait for the worker to finish processing
      await vi.waitFor(
        async () => {
          const r = await d.getRun(run.id)
          expect(r?.status).toBe('cancelled')
        },
        { timeout: 5000 },
      )

      // The step should NOT have been persisted as 'completed'
      const steps = await d.storage.getSteps(run.id)
      const completedSteps = steps.filter((s) => s.status === 'completed')
      expect(completedSteps).toHaveLength(0)

      await d.stop()
      await d.db.destroy()
    })
  })
}
