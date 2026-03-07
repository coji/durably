import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

describe('processUntilIdle serverless shape', () => {
  const runtimes: Array<Durably<any, any>> = []

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
  })

  function createSharedRuntimes(count = 1) {
    const dbFile = join(tmpdir(), `durably-serverless-${randomUUID()}.db`)
    const createDialect = () => createNodeDialectForFile(dbFile)
    const created = Array.from({ length: count }, () =>
      createDurably({ dialect: createDialect() }),
    )
    runtimes.push(...created)
    return created
  }

  it('respects maxRuns and leaves the remaining backlog for a later invocation', async () => {
    const [runtime] = createSharedRuntimes(1)
    const processedInputs: number[] = []

    const job = defineJob({
      name: 'serverless-batch',
      input: z.object({ n: z.number() }),
      output: z.object({ n: z.number() }),
      run: async (_step, input) => {
        processedInputs.push(input.n)
        return { n: input.n }
      },
    })

    const d = runtime.register({ job })
    await d.migrate()

    await d.jobs.job.trigger({ n: 1 })
    await d.jobs.job.trigger({ n: 2 })
    await d.jobs.job.trigger({ n: 3 })

    const firstSlice = await d.processUntilIdle({
      workerId: 'invocation-a',
      maxRuns: 2,
    })

    expect(firstSlice).toBe(2)
    expect(processedInputs).toEqual([1, 2])

    const midRuns = await d.jobs.job.getRuns()
    expect(midRuns.filter((run) => run.status === 'completed')).toHaveLength(2)
    expect(midRuns.filter((run) => run.status === 'pending')).toHaveLength(1)

    const secondSlice = await d.processUntilIdle({
      workerId: 'invocation-b',
      maxRuns: 2,
    })

    expect(secondSlice).toBe(1)
    expect(processedInputs).toEqual([1, 2, 3])

    const finalRuns = await d.jobs.job.getRuns()
    expect(finalRuns.every((run) => run.status === 'completed')).toBe(true)
  })

  it('returns quickly when there is no claimable work', async () => {
    const [runtime] = createSharedRuntimes(1)
    await runtime.migrate()

    const processed = await runtime.processUntilIdle({
      workerId: 'empty-invocation',
      maxRuns: 5,
    })

    expect(processed).toBe(0)
  })

  it('lets separate invocations split a backlog without double-processing runs', async () => {
    const [runtimeA, runtimeB] = createSharedRuntimes(2)
    const executions: string[] = []

    const job = defineJob({
      name: 'concurrent-serverless-batch',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
      run: async (_step, input) => {
        executions.push(input.id)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { id: input.id }
      },
    })

    const a = runtimeA.register({ job })
    const b = runtimeB.register({ job })

    await a.migrate()

    for (const id of ['a', 'b', 'c', 'd']) {
      await a.jobs.job.trigger({ id })
    }

    const [countA, countB] = await Promise.all([
      a.processUntilIdle({ workerId: 'invocation-a', maxRuns: 4 }),
      b.processUntilIdle({ workerId: 'invocation-b', maxRuns: 4 }),
    ])

    expect(countA + countB).toBe(4)
    expect(executions.sort()).toEqual(['a', 'b', 'c', 'd'])

    const runs = await a.jobs.job.getRuns()
    expect(runs.every((run) => run.status === 'completed')).toBe(true)
  })
})
