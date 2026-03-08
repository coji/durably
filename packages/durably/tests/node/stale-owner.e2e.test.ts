import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'
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
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
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
      leaseMs: 25,
      leaseRenewIntervalMs: 1_000,
    })

    runtimes.push(runtimeA, runtimeB)
    return { runtimeA, runtimeB }
  }

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
  })

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
  })
})
