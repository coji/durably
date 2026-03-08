/**
 * Tests for SQLITE_BUSY write contention with libsql.
 *
 * libsql opens separate SQLite connections for transactions,
 * which can cause SQLITE_BUSY when concurrent writes happen
 * (e.g., worker processing + user enqueue/delete).
 */
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

describe('libsql write contention', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanups.map((fn) => fn()))
    cleanups.length = 0
  })

  function setup() {
    const dbFile = join(tmpdir(), `durably-contention-${randomUUID()}.db`)
    const durably = createDurably({
      dialect: createNodeDialectForFile(dbFile),
      pollingIntervalMs: 10,
    })
    cleanups.push(async () => {
      await durably.stop()
      await durably.db.destroy()
    })
    return durably
  }

  it('enqueue during active worker does not cause SQLITE_BUSY', async () => {
    const d = setup().register({
      job: defineJob({
        name: 'slow-job',
        input: z.object({ i: z.number() }),
        run: async (step, input) => {
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
          return { done: input.i }
        },
      }),
    })

    await d.migrate()

    // Trigger initial job and start worker
    await d.jobs.job.trigger({ i: 0 })
    d.start()

    // Enqueue more jobs while worker is actively processing
    // This should not throw SQLITE_BUSY
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => d.jobs.job.trigger({ i: i + 1 })),
    )

    expect(results).toHaveLength(5)

    // Wait for all to complete
    await d.processUntilIdle()
    await d.stop()

    const runs = await d.jobs.job.getRuns()
    expect(runs).toHaveLength(6)
  })

  it('enqueueMany during active worker does not cause SQLITE_BUSY', async () => {
    const d = setup().register({
      job: defineJob({
        name: 'slow-job-batch',
        input: z.object({ i: z.number() }),
        run: async (step, input) => {
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
          return { done: input.i }
        },
      }),
    })

    await d.migrate()

    // Trigger initial job and start worker
    await d.jobs.job.trigger({ i: 0 })
    d.start()

    // Batch enqueue while worker is processing
    const results = await d.jobs.job.batchTrigger(
      Array.from({ length: 5 }, (_, i) => ({ i: i + 1 })),
    )

    expect(results).toHaveLength(5)

    await d.processUntilIdle()
    await d.stop()

    const runs = await d.jobs.job.getRuns()
    expect(runs).toHaveLength(6)
  })

  it('deleteRun during active worker does not cause SQLITE_BUSY', async () => {
    const d = setup().register({
      job: defineJob({
        name: 'delete-test-job',
        input: z.object({ i: z.number() }),
        run: async (step, input) => {
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 50))
          })
          return { done: input.i }
        },
      }),
    })

    await d.migrate()

    // Create some completed runs to delete
    for (let i = 0; i < 3; i++) {
      await d.jobs.job.trigger({ i })
    }
    await d.processUntilIdle()

    const completedRuns = await d.jobs.job.getRuns({ status: 'completed' })
    expect(completedRuns).toHaveLength(3)

    // Trigger new job and start worker
    await d.jobs.job.trigger({ i: 99 })
    d.start()

    // Delete completed runs while worker is processing a new one
    for (const run of completedRuns) {
      await d.deleteRun(run.id)
    }

    await d.processUntilIdle()
    await d.stop()

    const remainingRuns = await d.jobs.job.getRuns()
    expect(remainingRuns).toHaveLength(1)
    expect(remainingRuns[0].status).toBe('completed')
  })

  it('triggerAndWait with idempotencyKey does not cause SQLITE_BUSY', async () => {
    const d = setup().register({
      job: defineJob({
        name: 'idempotent-job',
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
        run: async () => {
          return { done: true }
        },
      }),
    })

    await d.migrate()
    d.start()

    // This was the exact scenario that originally triggered SQLITE_BUSY
    const { output } = await d.jobs.job.triggerAndWait(
      {},
      { idempotencyKey: 'test-key' },
    )
    expect(output).toEqual({ done: true })

    await d.stop()
  })

  it('concurrent enqueue and enqueueMany do not cause SQLITE_BUSY', async () => {
    const d = setup().register({
      job: defineJob({
        name: 'concurrent-enqueue-job',
        input: z.object({ i: z.number() }),
        run: async (step, input) => {
          await step.run('work', async () => {
            await new Promise((r) => setTimeout(r, 20))
          })
          return { done: input.i }
        },
      }),
    })

    await d.migrate()
    d.start()

    // Fire off single enqueues and batch enqueues concurrently
    const [singles, batch] = await Promise.all([
      Promise.all(
        Array.from({ length: 3 }, (_, i) => d.jobs.job.trigger({ i })),
      ),
      d.jobs.job.batchTrigger(
        Array.from({ length: 3 }, (_, i) => ({ i: i + 10 })),
      ),
    ])

    expect(singles).toHaveLength(3)
    expect(batch).toHaveLength(3)

    await d.processUntilIdle()
    await d.stop()

    const runs = await d.jobs.job.getRuns()
    expect(runs).toHaveLength(6)
  })
})
