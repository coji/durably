import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'
import { createNodeDialect } from '../helpers/node-dialect'

describe('Phase 1 exploration', () => {
  const runtimes: Array<Durably<any, any>> = []

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
  })

  it('processOne() acquires a lease and completes a pending run', async () => {
    const job = defineJob({
      name: 'phase1-process-one',
      input: z.object({ value: z.number() }),
      output: z.object({ doubled: z.number() }),
      run: async (_step, input) => ({ doubled: input.value * 2 }),
    })

    const durably = createDurably({
      dialect: createNodeDialect(),
      jobs: { job },
    })
    runtimes.push(durably)

    await durably.migrate()
    const run = await durably.jobs.job.trigger({ value: 21 })

    expect(run.status).toBe('pending')

    const processed = await durably.processOne({ workerId: 'worker-a' })
    expect(processed).toBe(true)

    const completedRun = await durably.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toEqual({ doubled: 42 })
  })

  it('expired leases are reclaimable by a later worker', async () => {
    let executions = 0

    const job = defineJob({
      name: 'phase1-reclaim',
      input: z.object({}),
      output: z.object({ executions: z.number() }),
      run: async () => {
        executions++
        return { executions }
      },
    })

    const durably = createDurably({
      dialect: createNodeDialect(),
      jobs: { job },
      leaseMs: 5,
    })
    runtimes.push(durably)

    await durably.migrate()
    const run = await durably.jobs.job.trigger({})

    const claimed = await durably.storage.claimNext(
      'stale-worker',
      new Date().toISOString(),
      5,
    )
    expect(claimed?.status).toBe('leased')

    await new Promise((resolve) => setTimeout(resolve, 20))

    const processed = await durably.processOne({ workerId: 'reclaimer' })
    expect(processed).toBe(true)

    const completedRun = await durably.getRun(run.id)
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.leaseOwner).toBeNull()
    expect(completedRun?.output).toEqual({ executions: 1 })
  })
})
