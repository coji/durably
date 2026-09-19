import type { Dialect } from 'kysely'
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../src/migrations'

export function createMigrateTests(createDialect: () => Dialect) {
  describe('migrate()', () => {
    let durably: Durably

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('creates durably_runs table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_runs'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_runs')
    })

    it('creates durably_steps table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_steps'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_steps')
    })

    it('creates durably_step_attempts table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_step_attempts'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
    })

    it('creates durably_logs table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_logs'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_logs')
    })

    it('creates durably_schema_versions table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_schema_versions'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_schema_versions')
    })

    it('records schema version after migration', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ version: number }>`
        SELECT version FROM durably_schema_versions ORDER BY version DESC LIMIT 1
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].version).toBe(LATEST_SCHEMA_VERSION)
    })

    it('creates durably_runs with lease columns', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        PRAGMA table_info('durably_runs')
      `.execute(durably.db)

      const columnNames = result.rows.map((row) => row.name)
      expect(columnNames).toContain('lease_owner')
      expect(columnNames).toContain('lease_expires_at')
      expect(columnNames).toContain('lease_generation')
    })

    it('is idempotent (can be called multiple times safely)', async () => {
      durably = createDurably({ dialect: createDialect() })

      await durably.migrate()
      await durably.migrate()
      await durably.migrate()

      const result = await sql<{ version: number }>`
        SELECT version FROM durably_schema_versions
      `.execute(durably.db)

      expect(result.rows).toHaveLength(LATEST_SCHEMA_VERSION)
    })

    it('upgrades a populated v1 run and checkpoint without creating a historical attempt', async () => {
      durably = createDurably({ dialect: createDialect() })
      await runMigrations(durably.db, { targetVersion: 1 })
      const { run } = await durably.storage.enqueue({
        jobName: 'legacy',
        input: { value: 1 },
      })
      const claimed = await durably.storage.claimNext(
        'worker',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed?.id).toBe(run.id)
      await durably.storage.persistStep(run.id, claimed!.leaseGeneration, {
        name: 'old-step',
        index: 0,
        status: 'completed',
        output: 42,
        startedAt: new Date().toISOString(),
      })
      await durably.migrate()
      expect((await durably.storage.getRun(run.id))?.input).toEqual({
        value: 1,
      })
      expect((await durably.storage.getSteps(run.id))[0].output).toBe(42)
      expect(await durably.getStepAttempts(run.id)).toEqual([])
    })
  })
}
