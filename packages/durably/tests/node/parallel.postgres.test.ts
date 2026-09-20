import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob } from '../../src'
import { createPostgresSchemaResource } from '../helpers/postgres-dialect'

const resource = createPostgresSchemaResource()
beforeAll(() => resource.setup())
afterAll(() => resource.cleanup())

it('joins out-of-order PostgreSQL branches with separate durable attempts', async () => {
  const durably = createDurably({
    dialect: resource.createDialect(),
    pollingIntervalMs: 50,
    preserveSteps: true,
  })
  await durably.migrate()
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  const d = durably.register({
    job: defineJob({
      name: 'parallel-postgres',
      input: z.object({}),
      output: z.object({ first: z.string(), second: z.string() }),
      run: async (step) =>
        step.all({
          first: async () => {
            await firstGate
            return 'one'
          },
          second: async () => {
            await secondGate
            return 'two'
          },
        }),
    }),
  })

  try {
    const run = await d.jobs.job.trigger({})
    d.start()
    await vi.waitFor(
      async () => {
        expect(await d.storage.getStepAttempts(run.id)).toHaveLength(2)
      },
      { timeout: 5000 },
    )
    releaseSecond()
    await vi.waitFor(
      async () => {
        expect(
          await d.storage.getCompletedStep(run.id, 'second'),
        ).toMatchObject({ output: 'two' })
      },
      { timeout: 5000 },
    )
    expect((await d.jobs.job.getRun(run.id))?.status).toBe('leased')
    releaseFirst()
    await vi.waitFor(
      async () => {
        const completed = await d.jobs.job.getRun(run.id)
        expect(completed?.status).toBe('completed')
        expect(completed?.output).toEqual({ first: 'one', second: 'two' })
      },
      { timeout: 5000 },
    )
    const attempts = await d.storage.getStepAttempts(run.id)
    expect(attempts).toHaveLength(2)
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      'completed',
      'completed',
    ])
  } finally {
    releaseFirst()
    releaseSecond()
    await durably.stop()
    await durably.db.destroy()
  }
})
