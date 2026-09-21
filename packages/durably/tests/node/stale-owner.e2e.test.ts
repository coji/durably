import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  createDurably,
  defineJob,
  type Durably,
  LeaseLostError,
} from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

describe('stale owner end-to-end', () => {
  const runtimes: Array<Durably<any, any>> = []

  function createDeferred() {
    let resolve!: () => void
    const promise = new Promise<void>((innerResolve) => {
      resolve = innerResolve
    })
    return { promise, resolve }
  }

  afterEach(async () => {
    const completed = runtimes.splice(0)
    await Promise.all(completed.map((runtime) => runtime.stop()))
    await Promise.all(completed.map((runtime) => runtime.db.destroy()))
  })

  function createSharedRuntimePair() {
    const dbFile = join(tmpdir(), `durably-stale-owner-${randomUUID()}.db`)
    const createDialect = () => createNodeDialectForFile(dbFile)

    const runtimeA = createDurably({
      dialect: createDialect(),
      leaseMs: 25,
      leaseRenewIntervalMs: 1_000,
    })
    const runtimeB = createDurably({
      dialect: createDialect(),
      // Only the original owner should expire. Give the reclaimer enough time
      // to finish even when CI stalls between its attempt and checkpoint.
      leaseMs: 30_000,
      leaseRenewIntervalMs: 1_000,
    })

    runtimes.push(runtimeA, runtimeB)
    return { runtimeA, runtimeB }
  }

  it('does not start a callback when cancellation wins before attempt insertion', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()
    const beginReached = createDeferred()
    const releaseBegin = createDeferred()
    let called = false
    const job = defineJob({
      name: 'cancel-before-attempt',
      input: z.object({}),
      run: async (step) => {
        await step.run('work', () => {
          called = true
        })
      },
    })
    const a = runtimeA.register({ job })
    await a.migrate()
    const run = await a.jobs.job.trigger({})
    const original = a.storage.beginStepAttempt
    a.storage.beginStepAttempt = async (...args) => {
      beginReached.resolve()
      await releaseBegin.promise
      return original(...args)
    }
    try {
      const processing = a.processOne()
      await beginReached.promise
      await runtimeB.storage.cancelRun(run.id, new Date().toISOString())
      releaseBegin.resolve()
      await processing
      expect(called).toBe(false)
      expect(await a.getStepAttempts(run.id)).toEqual([])
      expect((await a.getRun(run.id))?.status).toBe('cancelled')
    } finally {
      releaseBegin.resolve()
      a.storage.beginStepAttempt = original
    }
  })

  it('does not start a callback when a later lease generation wins before insertion', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()
    const beginReached = createDeferred()
    const releaseBegin = createDeferred()
    let called = false
    const job = defineJob({
      name: 'reclaim-before-attempt',
      input: z.object({}),
      run: async (step) => {
        await step.run('work', () => {
          called = true
        })
      },
    })
    const a = runtimeA.register({ job })
    await a.migrate()
    const run = await a.jobs.job.trigger({})
    const original = a.storage.beginStepAttempt
    a.storage.beginStepAttempt = async (...args) => {
      beginReached.resolve()
      await releaseBegin.promise
      return original(...args)
    }
    try {
      const processing = a.processOne()
      await beginReached.promise
      await new Promise((resolve) => setTimeout(resolve, 40))
      await runtimeB.storage.releaseExpiredLeases(new Date().toISOString())
      const claimed = await runtimeB.storage.claimNext(
        'new-owner',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed?.id).toBe(run.id)
      releaseBegin.resolve()
      await processing
      expect(called).toBe(false)
      expect(await a.getStepAttempts(run.id)).toEqual([])
      expect((await a.getRun(run.id))?.leaseGeneration).toBe(
        claimed!.leaseGeneration,
      )
    } finally {
      releaseBegin.resolve()
      a.storage.beginStepAttempt = original
    }
  })

  it('retains interrupted and successful attempts across lease recovery', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()
    const firstStarted = createDeferred()
    const releaseFirst = createDeferred()
    let executions = 0
    let staleWriteRejected = false

    const job = defineJob({
      name: 'attempt-recovery',
      input: z.object({}),
      run: async (step) => {
        await step.run('external-call', async (_signal, attempt) => {
          executions++
          if (executions === 1) {
            await attempt.setMetadata({ usage: 3 })
            firstStarted.resolve()
            await releaseFirst.promise
            try {
              await attempt.setMetadata({ usage: 999 })
            } catch (error) {
              staleWriteRejected = error instanceof LeaseLostError
            }
            return 'stale'
          }
          await attempt.setMetadata({ usage: 7 })
          return 'recovered'
        })
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })
    await a.migrate()
    const run = await a.jobs.job.trigger({})
    const firstProcess = a.processOne({ workerId: 'worker-a' })
    await firstStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await b.processOne({ workerId: 'worker-b' })).toBe(true)
    releaseFirst.resolve()
    await firstProcess

    const attempts = await a.getStepAttempts(run.id)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      status: 'started',
      metadata: { usage: 3 },
      completedAt: null,
      interruptionReason: 'lease-lost',
    })
    expect(attempts[1]).toMatchObject({
      status: 'completed',
      metadata: { usage: 7 },
      interruptionReason: null,
    })
    expect(attempts[0].id).not.toBe(attempts[1].id)
    expect(staleWriteRejected).toBe(true)
    expect((await a.getRun(run.id))?.status).toBe('completed')
  }, 15_000)

  it('does not let a stale worker overwrite a reclaimed completion', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()

    let executionCount = 0
    const firstExecutionStarted = createDeferred()
    const firstExecutionRelease = createDeferred()

    const job = defineJob({
      name: 'stale-complete',
      input: z.object({}),
      output: z.object({ winner: z.string() }),
      run: async () => {
        executionCount++

        if (executionCount === 1) {
          firstExecutionStarted.resolve()
          await firstExecutionRelease.promise
          return { winner: 'stale-worker' }
        }

        return { winner: 'reclaimer' }
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })

    await a.migrate()
    const run = await a.jobs.job.trigger({})

    const firstProcess = a.processOne({ workerId: 'worker-a' })
    await firstExecutionStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 40))

    const secondProcess = await b.processOne({ workerId: 'worker-b' })
    expect(secondProcess).toBe(true)

    firstExecutionRelease.resolve()
    await firstProcess

    const completedRun = await a.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toEqual({ winner: 'reclaimer' })
    expect(completedRun?.leaseOwner).toBeNull()
    expect(executionCount).toBe(2)
  })

  it('does not let a stale worker overwrite a reclaimed success with failure', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()

    let executionCount = 0
    const firstExecutionStarted = createDeferred()
    const firstExecutionRelease = createDeferred()

    const job = defineJob({
      name: 'stale-fail',
      input: z.object({}),
      output: z.object({ winner: z.string() }),
      run: async () => {
        executionCount++

        if (executionCount === 1) {
          firstExecutionStarted.resolve()
          await firstExecutionRelease.promise
          throw new Error('stale execution failed late')
        }

        return { winner: 'reclaimer' }
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })

    await a.migrate()
    const run = await a.jobs.job.trigger({})

    const firstProcess = a.processOne({ workerId: 'worker-a' })
    await firstExecutionStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 40))

    const secondProcess = await b.processOne({ workerId: 'worker-b' })
    expect(secondProcess).toBe(true)

    firstExecutionRelease.resolve()
    await firstProcess

    const completedRun = await a.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toEqual({ winner: 'reclaimer' })
    expect(completedRun?.error).toBeNull()
    expect(executionCount).toBe(2)
  })

  it('does not start a later step after lease ownership is lost', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()

    const firstStepStarted = createDeferred()
    const releaseFirstStep = createDeferred()
    let executionCount = 0
    let secondStepStarted = false

    const job = defineJob({
      name: 'lease-loss-step-boundary',
      input: z.object({}),
      output: z.object({ winner: z.string() }),
      run: async (step) => {
        executionCount++
        if (executionCount > 1) {
          return { winner: 'reclaimer' }
        }

        await step.run('step-1', async () => {
          firstStepStarted.resolve()
          await releaseFirstStep.promise
          return 'step-1'
        })

        await step.run('step-2', async () => {
          secondStepStarted = true
          return 'step-2'
        })

        return { winner: 'stale-worker' }
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })

    await a.migrate()
    const run = await a.jobs.job.trigger({})

    const firstProcess = a.processOne({ workerId: 'worker-a' })
    await firstStepStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 40))

    const secondProcessPromise = b.processOne({ workerId: 'worker-b' })

    releaseFirstStep.resolve()
    await firstProcess
    expect(secondStepStarted).toBe(false)

    const reclaimed = await secondProcessPromise
    expect(reclaimed).toBe(true)

    const completedRun = await a.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toEqual({ winner: 'reclaimer' })
  }, 15_000)

  it('aborts cooperative long-running work after lease ownership is lost', async () => {
    const { runtimeA, runtimeB } = createSharedRuntimePair()

    const firstStepStarted = createDeferred()
    let executionCount = 0
    let signalObservedAborted = false

    const job = defineJob({
      name: 'lease-loss-signal',
      input: z.object({}),
      output: z.object({ winner: z.string() }),
      run: async (step) => {
        executionCount++
        if (executionCount > 1) {
          return { winner: 'reclaimer' }
        }

        await step.run('long-step', async (signal) => {
          firstStepStarted.resolve()

          await new Promise<void>((resolve) => {
            const tick = () => {
              if (signal.aborted) {
                signalObservedAborted = true
                resolve()
                return
              }
              setTimeout(tick, 5)
            }
            tick()
          })

          step.throwIfAborted()
          return 'stale-worker'
        })

        return { winner: 'stale-worker' }
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })

    await a.migrate()
    const run = await a.jobs.job.trigger({})

    const firstProcess = a.processOne({ workerId: 'worker-a' })
    await firstStepStarted.promise
    await new Promise((resolve) => setTimeout(resolve, 40))

    const reclaimed = await b.processOne({ workerId: 'worker-b' })
    expect(reclaimed).toBe(true)

    await firstProcess

    expect(signalObservedAborted).toBe(true)

    const completedRun = await a.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toEqual({ winner: 'reclaimer' })
  }, 15_000)
})
