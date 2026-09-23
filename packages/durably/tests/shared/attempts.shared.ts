import type { Dialect } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  CancelledError,
  ConflictError,
  createDurably,
  defineJob,
  LeaseLostError,
  ValidationError,
  type Durably,
  type StepAttemptContext,
} from '../../src'
import { expireLease } from '../helpers/sync'

export function createAttemptTests(createDialect: () => Dialect) {
  describe('durable step attempts', () => {
    const runtimes: Durably<any, any>[] = []

    async function createRuntime(options: { preserveSteps?: boolean } = {}) {
      const runtime = createDurably({ dialect: createDialect(), ...options })
      runtimes.push(runtime)
      await runtime.migrate()
      return runtime
    }

    afterEach(async () => {
      await Promise.all(runtimes.map((runtime) => runtime.stop()))
      await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
      runtimes.length = 0
    })

    it('persists initial metadata before callback and replaces it durably', async () => {
      const runtime = await createRuntime({ preserveSteps: false })
      let attemptId = ''
      const job = defineJob({
        name: 'attempt-metadata',
        input: z.object({}),
        run: async (step) => {
          await step.run(
            'work',
            async (_signal, attempt) => {
              attemptId = attempt.id
              expect(attempt.metadata).toEqual({ model: 'alpha' })
              const started = await runtime.getStepAttempts(step.runId)
              expect(started).toHaveLength(1)
              expect(started[0]).toMatchObject({
                id: attempt.id,
                status: 'started',
                metadata: { model: 'alpha' },
                completedAt: null,
              })
              await attempt.setMetadata({ model: 'alpha', usage: 12 })
              await attempt.setMetadata({ model: 'alpha', usage: 12 })
              expect(attempt.metadata).toEqual({ model: 'alpha', usage: 12 })
              expect(
                (await runtime.getStepAttempts(step.runId))[0].metadata,
              ).toEqual({ model: 'alpha', usage: 12 })
              return 'done'
            },
            { metadata: { model: 'alpha' } },
          )
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('completed')
      expect(await d.storage.getSteps(run.id)).toEqual([])
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        {
          id: attemptId,
          stepName: 'work',
          status: 'completed',
          metadata: { model: 'alpha', usage: 12 },
          interruptionReason: null,
        },
      ])
    })

    it('records failed callbacks and preserves metadata', async () => {
      const runtime = await createRuntime()
      const job = defineJob({
        name: 'attempt-failure',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', async (_signal, attempt) => {
            await attempt.setMetadata({ usage: 5 })
            throw new Error('provider failed')
          })
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('failed')
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        {
          status: 'failed',
          metadata: { usage: 5 },
          error: 'provider failed',
          interruptionReason: null,
        },
      ])
    })

    it('does not create another attempt when a completed step is replayed', async () => {
      const runtime = await createRuntime({ preserveSteps: true })
      let calls = 0
      const job = defineJob({
        name: 'attempt-replay',
        input: z.object({}),
        run: async (step) => {
          const first = await step.run('work', () => ++calls)
          const second = await step.run('work', () => ++calls)
          expect([first, second]).toEqual([1, 1])
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect(calls).toBe(1)
      expect(await d.getStepAttempts(run.id)).toHaveLength(1)
    })

    it('finalizes concurrent step callbacks under their own attempt index', async () => {
      const runtime = await createRuntime({ preserveSteps: true })
      const job = defineJob({
        name: 'parallel-attempts',
        input: z.object({}),
        run: async (step) => {
          // 'slow' returns only after 'fast' has written its checkpoint, so
          // checkpoints land in the reverse of call order every time
          let fast!: Promise<string>
          const slow = step.run('slow', async () => {
            await fast
            return 'slow'
          })
          fast = step.run('fast', () => 'fast')
          await Promise.all([slow, fast])
          await step.run('after', () => 'after')
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('completed')
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        { stepName: 'slow', stepIndex: 0, status: 'completed' },
        { stepName: 'fast', stepIndex: 1, status: 'completed' },
        { stepName: 'after', stepIndex: 2, status: 'completed' },
      ])
      expect((await d.getRun(run.id))?.currentStepIndex).toBe(3)
    })

    it('keeps the next index stable when concurrent checkpoints replay after recovery', async () => {
      const runtime = await createRuntime({ preserveSteps: true })
      let invocations = 0
      const job = defineJob({
        name: 'parallel-replay-index',
        input: z.object({}),
        run: async (step) => {
          // 'slow' returns only after 'fast' has written its checkpoint, so
          // checkpoints land in the reverse of call order every time
          let fast!: Promise<number>
          const slow = step.run('slow', async () => {
            await fast
            return 1
          })
          fast = step.run('fast', () => 2)
          await Promise.all([slow, fast])
          if (++invocations === 1) throw new LeaseLostError(step.runId)
          await step.run('after', () => 3)
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('leased')
      expect((await d.getRun(run.id))?.currentStepIndex).toBe(2)
      await d.storage.updateRun(run.id, {
        leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      })
      await d.storage.releaseExpiredLeases(new Date().toISOString())
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('completed')
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        { stepName: 'slow', stepIndex: 0 },
        { stepName: 'fast', stepIndex: 1 },
        { stepName: 'after', stepIndex: 2 },
      ])
      expect((await d.getRun(run.id))?.currentStepIndex).toBe(3)
      expect(await d.storage.getSteps(run.id)).toHaveLength(3)
    })

    it('keeps the context metadata separate from a mutated caller value', async () => {
      const runtime = await createRuntime()
      const job = defineJob({
        name: 'attempt-metadata-snapshot',
        input: z.object({}),
        run: async (step) => {
          const initial = { usage: 1 }
          await step.run(
            'work',
            async (_signal, attempt) => {
              initial.usage = 2
              expect(attempt.metadata).toEqual({ usage: 1 })
              const next = { usage: 3 }
              await attempt.setMetadata(next)
              next.usage = 4
              expect(attempt.metadata).toEqual({ usage: 3 })
              const exposed = attempt.metadata as { usage: number }
              exposed.usage = 500
              expect(attempt.metadata).toEqual({ usage: 3 })
            },
            { metadata: initial },
          )
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getStepAttempts(run.id))[0].metadata).toEqual({
        usage: 3,
      })
    })

    it('returns the committed metadata snapshot if the caller mutates during the write', async () => {
      const runtime = await createRuntime()
      const job = defineJob({
        name: 'metadata-in-flight-snapshot',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', async (_signal, attempt) => {
            const value = { usage: 3 }
            const writing = attempt.setMetadata(value)
            value.usage = 99
            await writing
            expect(attempt.metadata).toEqual({ usage: 3 })
          })
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getStepAttempts(run.id))[0].metadata).toEqual({
        usage: 3,
      })
    })

    it('rejects invalid metadata before running a callback', async () => {
      const runtime = await createRuntime()
      let called = false
      const job = defineJob({
        name: 'invalid-attempt-metadata',
        input: z.object({}),
        run: async (step) => {
          await step.run(
            'work',
            () => {
              called = true
            },
            { metadata: Number.NaN },
          )
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect(called).toBe(false)
      expect(await d.getStepAttempts(run.id)).toEqual([])
      expect((await d.getRun(run.id))?.error).toContain('Attempt metadata')
    })

    it('does not invoke the callback when attempt insertion fails', async () => {
      const runtime = await createRuntime()
      let called = false
      const job = defineJob({
        name: 'attempt-insert-error',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', () => {
            called = true
          })
        },
      })
      const d = runtime.register({ job })
      const original = d.storage.beginStepAttempt
      d.storage.beginStepAttempt = async () => {
        throw new Error('attempt insert failed')
      }
      try {
        const run = await d.jobs.job.trigger({})
        await d.processOne()
        expect(called).toBe(false)
        expect((await d.getRun(run.id))?.status).toBe('failed')
        expect(await d.getStepAttempts(run.id)).toEqual([])
      } finally {
        d.storage.beginStepAttempt = original
      }
    })

    it('leaves a successful callback attempt unresolved when checkpoint storage fails', async () => {
      const runtime = await createRuntime({ preserveSteps: true })
      let callbackCalls = 0
      let failedEvents = 0
      const job = defineJob({
        name: 'checkpoint-storage-error',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', () => {
            callbackCalls++
            return 'done'
          })
        },
      })
      const d = runtime.register({ job })
      d.on('step:fail', () => failedEvents++)
      const original = d.storage.persistStep
      let completedWrites = 0
      d.storage.persistStep = async (runId, generation, input) => {
        if (input.status === 'completed') {
          completedWrites++
          throw new Error('checkpoint storage failed')
        }
        return original(runId, generation, input)
      }
      try {
        const run = await d.jobs.job.trigger({})
        await d.processOne()
        expect(callbackCalls).toBe(1)
        expect(completedWrites).toBe(1)
        expect(failedEvents).toBe(0)
        expect((await d.getRun(run.id))?.status).toBe('failed')
        expect(await d.storage.getSteps(run.id)).toEqual([])
        expect(await d.getStepAttempts(run.id)).toMatchObject([
          {
            status: 'started',
            error: null,
            completedAt: null,
            interruptionReason: 'unknown',
          },
        ])
      } finally {
        d.storage.persistStep = original
      }
    })

    it('reports Proxy metadata validation failures without writing them', async () => {
      const runtime = await createRuntime()
      const revoked = Proxy.revocable({ usage: 1 }, {})
      revoked.revoke()
      let callbackCalls = 0
      const job = defineJob({
        name: 'proxy-metadata',
        input: z.object({}),
        run: async (step) => {
          await expect(
            step.run(
              'invalid-initial',
              () => {
                callbackCalls++
              },
              { metadata: revoked.proxy },
            ),
          ).rejects.toBeInstanceOf(ValidationError)
          await step.run(
            'valid-initial',
            async (_signal, attempt) => {
              callbackCalls++
              await expect(
                attempt.setMetadata(revoked.proxy),
              ).rejects.toBeInstanceOf(ValidationError)
              expect(attempt.metadata).toEqual({ usage: 2 })
            },
            { metadata: { usage: 2 } },
          )
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('completed')
      expect(callbackCalls).toBe(1)
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        {
          stepName: 'valid-initial',
          metadata: { usage: 2 },
          status: 'completed',
        },
      ])
    })

    it('rejects undefined, accessors, and extra array properties without a callback', async () => {
      const runtime = await createRuntime()
      let calls = 0
      const invalidValues: unknown[] = [undefined]
      const stateful = Object.defineProperty({}, 'usage', {
        enumerable: true,
        get: () => Number.NaN,
      })
      invalidValues.push(stateful)
      const array: unknown[] = [1]
      Object.assign(array, { extra: undefined })
      invalidValues.push(array)
      invalidValues.push(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('reflection failed')
            },
          },
        ),
      )
      for (const metadata of invalidValues) {
        const { run } = await runtime.storage.enqueue({
          jobName: 'invalid-values',
          input: {},
        })
        const claimed = await runtime.storage.claimNext(
          'worker',
          new Date().toISOString(),
          30_000,
        )
        expect(claimed?.id).toBe(run.id)
        await expect(
          runtime.storage.beginStepAttempt(run.id, claimed!.leaseGeneration, {
            name: 'work',
            index: 0,
            metadata: metadata as never,
          }),
        ).rejects.toBeInstanceOf(ValidationError)
        expect(await runtime.getStepAttempts(run.id)).toEqual([])
        await runtime.storage.cancelRun(run.id, new Date().toISOString())
      }
      const job = defineJob({
        name: 'explicit-undefined',
        input: z.object({}),
        run: async (step) => {
          await step.run(
            'work',
            () => {
              calls++
            },
            { metadata: undefined as never },
          )
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect(calls).toBe(0)
      expect(await d.getStepAttempts(run.id)).toEqual([])
    })

    it('derives lease loss after pending release and expiry conflict', async () => {
      const runtime = await createRuntime()
      const first = await runtime.storage.enqueue({
        jobName: 'pending-release',
        input: {},
      })
      const claimedFirst = await runtime.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimedFirst?.id).toBe(first.run.id)
      await runtime.storage.beginStepAttempt(
        first.run.id,
        claimedFirst!.leaseGeneration,
        {
          name: 'work',
          index: 0,
        },
      )
      const second = await runtime.storage.enqueue({
        jobName: 'expiry-conflict',
        input: {},
        concurrencyKey: 'conflict',
      })
      const claimedSecond = await runtime.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimedSecond?.id).toBe(second.run.id)
      await runtime.storage.beginStepAttempt(
        second.run.id,
        claimedSecond!.leaseGeneration,
        {
          name: 'work',
          index: 0,
        },
      )
      const replacement = await runtime.storage.enqueue({
        jobName: 'expiry-conflict',
        input: { later: true },
        concurrencyKey: 'conflict',
      })
      await runtime.storage.releaseExpiredLeases(
        new Date(Date.parse(claimedSecond!.leaseExpiresAt!) + 1).toISOString(),
      )
      expect((await runtime.storage.getRun(first.run.id))?.status).toBe(
        'pending',
      )
      expect(
        (await runtime.getStepAttempts(first.run.id))[0].interruptionReason,
      ).toBe('lease-lost')
      expect((await runtime.storage.getRun(second.run.id))?.status).toBe(
        'failed',
      )
      expect(
        (await runtime.getStepAttempts(second.run.id))[0].interruptionReason,
      ).toBe('lease-lost')
      await runtime.storage.cancelRun(first.run.id, new Date().toISOString())
      await runtime.storage.cancelRun(
        replacement.run.id,
        new Date().toISOString(),
      )
    })

    it('returns no attempts for an unknown run and purges attempts with the run', async () => {
      const runtime = await createRuntime()
      expect(await runtime.getStepAttempts('missing')).toEqual([])
      const job = defineJob({
        name: 'attempt-delete',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', () => 1, { metadata: null })
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        { metadata: null },
      ])
      await d.deleteRun(run.id)
      expect(await d.getStepAttempts(run.id)).toEqual([])
    })

    it('direct Store deletion removes a leased run and its attempts', async () => {
      const runtime = await createRuntime()
      const { run } = await runtime.storage.enqueue({
        jobName: 'store-delete',
        input: {},
      })
      const claimed = await runtime.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed?.id).toBe(run.id)
      const attempt = await runtime.storage.beginStepAttempt(
        run.id,
        claimed!.leaseGeneration,
        {
          name: 'work',
          index: 0,
        },
      )
      expect(attempt).not.toBeNull()
      await runtime.storage.deleteRun(run.id)
      expect(await runtime.storage.getRun(run.id)).toBeNull()
      expect(await runtime.storage.getStepAttempt(attempt!.id)).toBeNull()
      expect(
        await runtime.storage.beginStepAttempt(
          run.id,
          claimed!.leaseGeneration,
          {
            name: 'work',
            index: 1,
          },
        ),
      ).toBeNull()
    })

    it('removes attempts through retention purging', async () => {
      const runtime = await createRuntime()
      const job = defineJob({
        name: 'attempt-purge',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', () => 1)
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect(await d.getStepAttempts(run.id)).toHaveLength(1)
      expect(
        await d.purgeRuns({ olderThan: new Date(Date.now() + 60_000) }),
      ).toBeGreaterThanOrEqual(1)
      expect(await d.getStepAttempts(run.id)).toEqual([])
    })

    it('refuses metadata writes after an attempt has finalized', async () => {
      const runtime = await createRuntime()
      const job = defineJob({
        name: 'finalized-attempt',
        input: z.object({}),
        run: async (step) => {
          let savedAttempt: StepAttemptContext | undefined
          await step.run('work', (_signal, attempt) => {
            savedAttempt = attempt
            return 1
          })
          expect(savedAttempt).toBeDefined()
          await expect(
            savedAttempt!.setMetadata({ tooLate: true }),
          ).rejects.toBeInstanceOf(ConflictError)
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      await d.processOne()
      expect((await d.getRun(run.id))?.status).toBe('completed')
      expect((await d.getStepAttempts(run.id))[0].metadata).toBeNull()
    })

    it('refuses an in-flight metadata replacement when finalization wins', async () => {
      const runtime = await createRuntime()
      let reached!: () => void
      const updateReached = new Promise<void>((resolve) => {
        reached = resolve
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let finalized!: () => void
      const stepFinalized = new Promise<void>((resolve) => {
        finalized = resolve
      })
      let finishJob!: () => void
      const jobHeld = new Promise<void>((resolve) => {
        finishJob = resolve
      })
      const original = runtime.storage.updateStepAttemptMetadata
      runtime.storage.updateStepAttemptMetadata = async (...args) => {
        reached()
        await held
        return original(...args)
      }
      let metadataWrite!: Promise<void>
      try {
        const job = defineJob({
          name: 'metadata-finalization-race',
          input: z.object({}),
          run: async (step) => {
            await step.run('work', (_signal, attempt) => {
              metadataWrite = attempt.setMetadata({ usage: 1 })
              return 42
            })
            finalized()
            await jobHeld
          },
        })
        const d = runtime.register({ job })
        const run = await d.jobs.job.trigger({})
        const processing = d.processOne()
        await updateReached
        await stepFinalized
        release()
        await expect(metadataWrite).rejects.toBeInstanceOf(ConflictError)
        expect((await d.getStepAttempts(run.id))[0].metadata).toBeNull()
        finishJob()
        await processing
      } finally {
        release()
        finishJob()
        runtime.storage.updateStepAttemptMetadata = original
      }
    })

    it('derives cancellation without claiming a confirmed callback end', async () => {
      const runtime = await createRuntime()
      let signalStarted!: () => void
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve
      })
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let rejected = false
      const job = defineJob({
        name: 'cancelled-attempt',
        input: z.object({}),
        run: async (step) => {
          await step.run('work', async (_signal, attempt) => {
            await attempt.setMetadata({ usage: 2 })
            signalStarted()
            await held
            try {
              await attempt.setMetadata({ usage: 3 })
            } catch (error) {
              rejected = error instanceof CancelledError
            }
            return 1
          })
        },
      })
      const d = runtime.register({ job })
      const run = await d.jobs.job.trigger({})
      const processing = d.processOne()
      await started
      await d.cancel(run.id)
      release()
      await processing
      expect(rejected).toBe(true)
      expect(await d.getStepAttempts(run.id)).toMatchObject([
        {
          status: 'started',
          metadata: { usage: 2 },
          completedAt: null,
          interruptionReason: 'cancelled',
        },
      ])
    })

    it('keeps an attempt unresolved when checkpoint insertion rolls back', async () => {
      const runtime = await createRuntime({ preserveSteps: true })
      const { run } = await runtime.storage.enqueue({
        jobName: 'rollback',
        input: {},
      })
      const claimed = await runtime.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed?.id).toBe(run.id)
      const generation = claimed!.leaseGeneration
      await runtime.storage.persistStep(run.id, generation, {
        name: 'work',
        index: 0,
        status: 'completed',
        output: 1,
        startedAt: new Date().toISOString(),
      })
      const attempt = await runtime.storage.beginStepAttempt(
        run.id,
        generation,
        { name: 'work', index: 0 },
      )
      expect(attempt).not.toBeNull()
      await expect(
        runtime.storage.persistStep(run.id, generation, {
          name: 'work',
          index: 0,
          status: 'completed',
          output: 2,
          startedAt: attempt!.startedAt,
          attemptId: attempt!.id,
        }),
      ).rejects.toThrow()
      expect((await runtime.storage.getStepAttempt(attempt!.id))?.status).toBe(
        'started',
      )
      expect(await runtime.storage.getSteps(run.id)).toHaveLength(1)
    })

    it('rejects beginning an attempt after lease expiry', async () => {
      const runtime = await createRuntime()
      const { run } = await runtime.storage.enqueue({
        jobName: 'expired',
        input: {},
      })
      const claimed = await runtime.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed).not.toBeNull()
      await expireLease(runtime, run.id)
      expect(
        await runtime.storage.beginStepAttempt(
          run.id,
          claimed!.leaseGeneration,
          {
            name: 'work',
            index: 0,
          },
        ),
      ).toBeNull()
      expect(await runtime.getStepAttempts(run.id)).toEqual([])
    })
  })
}
