import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import {
  CancelledError,
  createDurably,
  defineJob,
  NotFoundError,
  type Durably,
} from '../../src'
import { createPostgresSchemaResource } from '../helpers/postgres-dialect'

async function waitForPendingRunOnB(b: Durably<any, any>) {
  await vi.waitFor(
    async () => {
      const pending = await b.getRuns({ status: 'pending' })
      if (pending.length < 1) throw new Error('no pending run')
    },
    { timeout: 5000 },
  )
}

const resource = createPostgresSchemaResource()

beforeAll(async () => {
  await resource.setup()
})

afterAll(async () => {
  await resource.cleanup()
})

describe.sequential(
  'waitForRun / triggerAndWait with shared storage (cross-runtime)',
  () => {
    const runtimes: Array<Durably<any, any>> = []

    afterEach(async () => {
      await Promise.all(runtimes.map((r) => r.stop()))
      await Promise.all(runtimes.map((r) => r.db.destroy()))
      runtimes.length = 0
    })

    function createPair(pollingIntervalMs: number) {
      const dialect = () => resource.createDialect()
      const runtimeA = createDurably({
        dialect: dialect(),
        pollingIntervalMs,
      })
      const runtimeB = createDurably({
        dialect: dialect(),
        pollingIntervalMs,
      })
      runtimes.push(runtimeA, runtimeB)
      return { runtimeA, runtimeB }
    }

    it('durably.waitForRun() observes completion from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-wait-complete',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const run = await a.jobs.job.trigger({})
      const wait = a.waitForRun(run.id)
      const assertDone = expect(wait).resolves.toMatchObject({
        status: 'completed',
        output: { ok: true },
      })
      expect(await b.processOne({ workerId: 'worker-b' })).toBe(true)
      await assertDone
    })

    it('job.triggerAndWait() observes completion from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-trigger-wait-complete',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        run: async () => ({ ok: true }),
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const p = a.jobs.job.triggerAndWait({})
      const assertDone = expect(p).resolves.toMatchObject({
        output: { ok: true },
      })
      await waitForPendingRunOnB(b)
      expect(await b.processOne({ workerId: 'worker-b' })).toBe(true)
      await assertDone
    })

    it('durably.waitForRun() observes failure from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-wait-fail',
        input: z.object({}),
        output: z.object({}),
        run: async () => {
          throw new Error('cross-runtime failure')
        },
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const run = await a.jobs.job.trigger({})
      const wait = a.waitForRun(run.id)
      const assertDone = expect(wait).rejects.toThrow('cross-runtime failure')
      expect(await b.processOne({ workerId: 'worker-b' })).toBe(true)
      await assertDone
    })

    it('job.triggerAndWait() observes failure from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-trigger-wait-fail',
        input: z.object({}),
        output: z.object({}),
        run: async () => {
          throw new Error('cross-runtime trigger failure')
        },
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const p = a.jobs.job.triggerAndWait({})
      const assertDone = expect(p).rejects.toThrow(
        'cross-runtime trigger failure',
      )
      await waitForPendingRunOnB(b)
      expect(await b.processOne({ workerId: 'worker-b' })).toBe(true)
      await assertDone
    })

    it('durably.waitForRun() observes cancellation from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-wait-cancel',
        input: z.object({}),
        run: async () => {},
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const run = await a.jobs.job.trigger({})
      const wait = a.waitForRun(run.id)
      const assertDone = expect(wait).rejects.toThrow(CancelledError)
      await b.cancel(run.id)
      await assertDone
    })

    it('job.triggerAndWait() observes cancellation from another runtime', async () => {
      const { runtimeA, runtimeB } = createPair(25)
      const job = defineJob({
        name: 'cross-trigger-wait-cancel',
        input: z.object({}),
        run: async () => {},
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const p = a.jobs.job.triggerAndWait({})
      const assertDone = expect(p).rejects.toThrow(CancelledError)
      await waitForPendingRunOnB(b)
      const pending = await b.getRuns({ status: 'pending' })
      expect(pending).toHaveLength(1)
      await b.cancel(pending[0].id)
      await assertDone
    })

    it('durably.waitForRun() rejects with NotFoundError when the run is deleted after polling starts', async () => {
      const { runtimeA, runtimeB } = createPair(500)
      let release!: () => void
      const hold = new Promise<void>((r) => {
        release = r
      })
      const job = defineJob({
        name: 'cross-wait-delete',
        input: z.object({}),
        output: z.object({ n: z.number() }),
        run: async (step) => {
          await step.run('hold', async () => {
            await hold
          })
          return { n: 1 }
        },
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const run = await a.jobs.job.trigger({})
      const wait = a.waitForRun(run.id)
      const assertDone = expect(wait).rejects.toThrow(NotFoundError)
      await waitForPendingRunOnB(b)
      const process = b.processOne({ workerId: 'worker-b' })
      await vi.waitFor(
        async () => {
          const leased = await b.getRuns({ status: 'leased' })
          if (leased.length < 1) throw new Error('not leased')
        },
        { timeout: 5000 },
      )
      release()
      await process
      await b.deleteRun(run.id)
      await assertDone
    })

    it('job.triggerAndWait() rejects with NotFoundError when the run is deleted after polling starts', async () => {
      const { runtimeA, runtimeB } = createPair(500)
      let release!: () => void
      const hold = new Promise<void>((r) => {
        release = r
      })
      const job = defineJob({
        name: 'cross-trigger-wait-delete',
        input: z.object({}),
        output: z.object({ n: z.number() }),
        run: async (step) => {
          await step.run('hold', async () => {
            await hold
          })
          return { n: 1 }
        },
      })
      const a = runtimeA.register({ job })
      const b = runtimeB.register({ job })
      await a.migrate()
      await b.migrate()

      const p = a.jobs.job.triggerAndWait({})
      const assertDone = expect(p).rejects.toThrow(NotFoundError)
      await waitForPendingRunOnB(b)
      const process = b.processOne({ workerId: 'worker-b' })
      await vi.waitFor(
        async () => {
          const leased = await b.getRuns({ status: 'leased' })
          if (leased.length < 1) throw new Error('not leased')
        },
        { timeout: 5000 },
      )
      const runs = await b.getRuns({ status: 'leased' })
      const runId = runs[0].id
      release()
      await process
      await b.deleteRun(runId)
      await assertDone
    })
  },
)
