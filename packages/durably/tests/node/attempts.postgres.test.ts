import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDurably } from '../../src'
import { runMigrations } from '../../src/migrations'
import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createAttemptTests } from '../shared/attempts.shared'

const resource = createPostgresSchemaResource()
beforeAll(() => resource.setup())
afterAll(() => resource.cleanup())
createAttemptTests(resource.createDialect)

it('upgrades populated PostgreSQL v1 data without changing the run or checkpoint', async () => {
  const legacy = createPostgresSchemaResource()
  await legacy.setup()
  const runtime = createDurably({ dialect: legacy.createDialect() })
  try {
    await runMigrations(runtime.db, { targetVersion: 1 })
    const { run } = await runtime.storage.enqueue({
      jobName: 'legacy',
      input: { value: 1 },
    })
    const claimed = await runtime.storage.claimNext(
      'worker',
      new Date().toISOString(),
      30_000,
    )
    expect(claimed?.id).toBe(run.id)
    await runtime.storage.persistStep(run.id, claimed!.leaseGeneration, {
      name: 'old-step',
      index: 0,
      status: 'completed',
      output: 42,
      startedAt: new Date().toISOString(),
    })
    await runtime.migrate()
    expect((await runtime.storage.getRun(run.id))?.input).toEqual({ value: 1 })
    expect((await runtime.storage.getSteps(run.id))[0].output).toBe(42)
    expect(await runtime.getStepAttempts(run.id)).toEqual([])
  } finally {
    await runtime.db.destroy()
    await legacy.cleanup()
  }
})
