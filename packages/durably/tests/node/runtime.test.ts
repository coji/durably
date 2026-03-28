import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createEventEmitter, type RunLeasedEvent } from '../../src/events'
import type { RegisteredJob } from '../../src/job'
import {
  executeRun,
  type RuntimeClock,
  type RuntimeEnvironment,
} from '../../src/runtime'
import type { Run, Step, Store } from '../../src/storage'

function makeRun(overrides: Partial<Run> = {}): Run {
  const base: Run = {
    id: 'run-1',
    jobName: 'job',
    input: {},
    status: 'leased',
    idempotencyKey: null,
    concurrencyKey: null,
    currentStepIndex: 0,
    completedStepCount: 0,
    progress: null,
    output: null,
    error: null,
    labels: {},
    leaseOwner: 'worker-a',
    leaseExpiresAt: new Date(1_700_000_030_000).toISOString(),
    leaseGeneration: 1,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(1_700_000_000_000).toISOString(),
    updatedAt: new Date(1_700_000_000_000).toISOString(),
  }
  return { ...base, ...overrides }
}

function makeJob(
  fn: RegisteredJob<unknown, unknown>['fn'],
  outputSchema?: z.ZodType,
): RegisteredJob<unknown, unknown> {
  return {
    name: 'job',
    inputSchema: z.unknown(),
    outputSchema,
    labelsSchema: undefined,
    fn,
    jobDef: {} as RegisteredJob<unknown, unknown>['jobDef'],
    handle: {} as RegisteredJob<unknown, unknown>['handle'],
  }
}

function unimplemented(): never {
  throw new Error('unimplemented')
}

function createMockStore(overrides: object = {}): Store {
  const base: Store = {
    enqueue: async () => unimplemented(),
    enqueueMany: async () => unimplemented(),
    getRun: async () => null,
    getRuns: async () => [],
    updateRun: async () => undefined,
    deleteRun: async () => undefined,
    claimNext: async () => null,
    renewLease: async () => true,
    releaseExpiredLeases: async () => 0,
    completeRun: async () => true,
    failRun: async () => true,
    cancelRun: async () => true,
    persistStep: async () => null,
    getSteps: async () => [],
    getCompletedStep: async () => null,
    deleteSteps: async () => undefined,
    updateProgress: async () => undefined,
    purgeRuns: async () => 0,
    createLog: async () => unimplemented(),
    getLogs: async () => [],
  }
  return { ...base, ...overrides } as unknown as Store
}

interface FakeClock {
  clock: RuntimeClock
  advance(ms: number): void
}

function createFakeClock(startMs = 1_700_000_000_000): FakeClock {
  let now = startMs
  let nextId = 1
  const timers = new Map<
    number,
    { fn: () => void; due: number; repeat?: number }
  >()

  function fireDue(end: number) {
    while (true) {
      let best: { id: number; due: number } | null = null
      for (const [id, t] of timers) {
        if (t.due <= end && (!best || t.due < best.due)) {
          best = { id, due: t.due }
        }
      }
      if (!best) {
        now = end
        return
      }
      now = best.due
      const entry = timers.get(best.id)
      if (!entry) {
        continue
      }
      entry.fn()
      if (entry.repeat !== undefined) {
        entry.due = now + entry.repeat
      } else {
        timers.delete(best.id)
      }
    }
  }

  return {
    clock: {
      now: () => now,
      setTimeout(fn, ms) {
        const id = nextId++
        timers.set(id, { fn, due: now + ms })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout(id) {
        timers.delete(id as unknown as number)
      },
      setInterval(fn, ms) {
        const id = nextId++
        timers.set(id, { fn, due: now + ms, repeat: ms })
        return id as unknown as ReturnType<typeof setInterval>
      },
      clearInterval(id) {
        timers.delete(id as unknown as number)
      },
    },
    advance(ms) {
      fireDue(now + ms)
    },
  }
}

function envFor<T extends Record<string, string>>(
  storage: Store<T>,
  eventEmitter: ReturnType<typeof createEventEmitter>,
  clock: RuntimeClock,
): RuntimeEnvironment<T> {
  return { storage, eventEmitter, clock }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

describe('executeRun (runtime kernel)', () => {
  const config = {
    leaseMs: 30_000,
    leaseRenewIntervalMs: 5_000,
    preserveSteps: false,
  }

  it('completes normally, emits run:leased and run:complete, deletes steps when preserveSteps is false', async () => {
    const run = makeRun()
    const deleteSteps = vi.fn(async () => undefined)
    const completeRun = vi.fn(async () => true)
    const storage = createMockStore({
      completeRun,
      deleteSteps,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const events: string[] = []
    eventEmitter.on('run:leased', () => events.push('run:leased'))
    eventEmitter.on('run:complete', () => events.push('run:complete'))

    const { clock } = createFakeClock()
    const result = await executeRun(
      run,
      makeJob(async () => ({ ok: 1 })),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(result).toEqual({ kind: 'completed' })
    expect(completeRun).toHaveBeenCalledTimes(1)
    expect(deleteSteps).toHaveBeenCalledWith(run.id)
    expect(events).toEqual(['run:leased', 'run:complete'])
  })

  it('replays a completed step without re-executing the step body', async () => {
    const run = makeRun()
    const inner = vi.fn(() => {
      throw new Error('step body should not run')
    })
    const cached: Step = {
      id: 'st1',
      runId: run.id,
      name: 'cached',
      index: 0,
      status: 'completed',
      output: { replayed: true },
      error: null,
      startedAt: '',
      completedAt: null,
    }
    const storage = createMockStore({
      completeRun: async () => true,
      getRun: async (runId: string) => (runId === run.id ? run : null),
      getCompletedStep: async (_runId: string, name: string) =>
        name === 'cached' ? cached : null,
    })
    const eventEmitter = createEventEmitter()
    const { clock } = createFakeClock()

    const result = await executeRun(
      run,
      makeJob(async (step) => {
        const v = await step.run('cached', inner)
        return v
      }),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(result).toEqual({ kind: 'completed' })
    expect(inner).not.toHaveBeenCalled()
  })

  it('emits run:lease-renewed after the lease renewal interval', async () => {
    const run = makeRun()
    const renewLease = vi.fn(async () => true)
    const storage = createMockStore({
      renewLease,
      completeRun: async () => true,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const renewed: unknown[] = []
    eventEmitter.on('run:lease-renewed', (e) => renewed.push(e))

    const { clock, advance } = createFakeClock()
    const exec = executeRun(
      run,
      makeJob(async () => {
        await new Promise<void>((resolve) => {
          clock.setTimeout(resolve, 25_000)
        })
        return { ok: true }
      }),
      config,
      envFor(storage, eventEmitter, clock),
    )

    advance(5_000)
    await flushAsyncWork()
    expect(renewLease).toHaveBeenCalled()
    expect(renewed.length).toBe(1)

    advance(25_000)
    await flushAsyncWork()
    await exec

    expect(renewed.length).toBeGreaterThanOrEqual(1)
  })

  it('emits worker:error when renewLease loses ownership', async () => {
    const run = makeRun()
    const storage = createMockStore({
      renewLease: async () => false,
      completeRun: async () => true,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const workerErrors: unknown[] = []
    eventEmitter.on('worker:error', (e) => workerErrors.push(e))

    const { clock, advance } = createFakeClock()
    const exec = executeRun(
      run,
      makeJob(async () => {
        await new Promise<void>((resolve) => {
          clock.setTimeout(resolve, 20_000)
        })
        return { ok: true }
      }),
      config,
      envFor(storage, eventEmitter, clock),
    )

    advance(5_000)
    await flushAsyncWork()
    expect(
      workerErrors.some(
        (e) => (e as { context?: string }).context === 'lease-renewal',
      ),
    ).toBe(true)

    advance(20_000)
    await flushAsyncWork()
    const result = await exec
    expect(result.kind).toBe('completed')
  })

  it('emits worker:error when renewLease rejects', async () => {
    const run = makeRun()
    const storage = createMockStore({
      renewLease: async () => {
        throw new Error('db down')
      },
      completeRun: async () => true,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const workerErrors: { error: string }[] = []
    eventEmitter.on('worker:error', (e) => workerErrors.push(e))

    const { clock, advance } = createFakeClock()
    const exec = executeRun(
      run,
      makeJob(async () => {
        await new Promise<void>((resolve) => {
          clock.setTimeout(resolve, 20_000)
        })
        return { ok: true }
      }),
      config,
      envFor(storage, eventEmitter, clock),
    )

    advance(5_000)
    await flushAsyncWork()
    expect(workerErrors.some((e) => e.error.includes('db down'))).toBe(true)

    advance(20_000)
    await flushAsyncWork()
    await exec
  })

  it('returns lease-lost and skips deleteSteps when completeRun refuses the transition', async () => {
    const run = makeRun()
    const deleteSteps = vi.fn(async () => undefined)
    const storage = createMockStore({
      completeRun: async () => false,
      deleteSteps,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const workerErrors: unknown[] = []
    eventEmitter.on('worker:error', (e) => workerErrors.push(e))

    const { clock } = createFakeClock()
    const result = await executeRun(
      run,
      makeJob(async () => ({ ok: 1 })),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(result).toEqual({ kind: 'lease-lost' })
    expect(deleteSteps).not.toHaveBeenCalled()
    expect(
      workerErrors.some(
        (e) => (e as { context?: string }).context === 'run-completion',
      ),
    ).toBe(true)
  })

  it('returns cancelled and skips deleteSteps when the run is already cancelled in storage', async () => {
    const run = makeRun()
    const deleteSteps = vi.fn(async () => undefined)
    const storage = createMockStore({
      completeRun: async () => true,
      deleteSteps,
      getRun: async (_runId: string) => ({
        ...run,
        status: 'cancelled' as const,
      }),
    })
    const eventEmitter = createEventEmitter()
    const { clock } = createFakeClock()

    const result = await executeRun(
      run,
      makeJob(async (step) => step.run('x', () => 1)),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(result).toEqual({ kind: 'cancelled' })
    expect(deleteSteps).not.toHaveBeenCalled()
  })

  it('fails the run when job output fails schema validation', async () => {
    const run = makeRun()
    const failRun = vi.fn(async () => true)
    const storage = createMockStore({
      failRun,
      getSteps: async () => [
        {
          id: 's',
          runId: run.id,
          name: 'x',
          index: 0,
          status: 'failed',
          output: null,
          error: 'bad',
          startedAt: '',
          completedAt: null,
        },
      ],
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const { clock } = createFakeClock()

    const result = await executeRun(
      run,
      makeJob(async () => ({ wrong: 'shape' }), z.object({ ok: z.number() })),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(result).toEqual({ kind: 'failed' })
    expect(failRun).toHaveBeenCalled()
  })

  it('uses run.leaseOwner in run:leased (not a separate worker id)', async () => {
    const run = makeRun({ leaseOwner: 'from-run' })
    const storage = createMockStore({
      completeRun: async () => true,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const leased: RunLeasedEvent[] = []
    eventEmitter.on('run:leased', (e: RunLeasedEvent) => {
      leased.push(e)
    })

    const { clock } = createFakeClock()
    await executeRun(
      run,
      makeJob(async () => ({ ok: 1 })),
      config,
      envFor(storage, eventEmitter, clock),
    )

    expect(leased[0]?.leaseOwner).toBe('from-run')
  })

  it('preserves steps when preserveSteps is true after terminal completion', async () => {
    const run = makeRun()
    const deleteSteps = vi.fn(async () => undefined)
    const storage = createMockStore({
      completeRun: async () => true,
      deleteSteps,
      getRun: async (runId: string) => (runId === run.id ? run : null),
    })
    const eventEmitter = createEventEmitter()
    const { clock } = createFakeClock()

    await executeRun(
      run,
      makeJob(async () => ({ ok: 1 })),
      { ...config, preserveSteps: true },
      envFor(storage, eventEmitter, clock),
    )

    expect(deleteSteps).not.toHaveBeenCalled()
  })
})
