import { type Kysely, sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably } from '../../src'
import { LATEST_SCHEMA_VERSION, runMigrations } from '../../src/migrations'
import type { Database } from '../../src/schema'
import { seedLegacyRun } from '../helpers/legacy-fixture'
import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'

describe('migration consolidated schema', () => {
  const dbs: Array<Kysely<Database>> = []

  afterEach(async () => {
    await Promise.all(dbs.map((db) => db.destroy()))
  })

  it('creates all tables with correct columns', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(durably.db)

    await durably.migrate()

    // Verify runs table has lease columns
    const runsColumns = await sql<{ name: string }>`
      PRAGMA table_info('durably_runs')
    `.execute(durably.db)
    const columnNames = runsColumns.rows.map((row) => row.name)
    expect(columnNames).toContain('lease_owner')
    expect(columnNames).toContain('lease_expires_at')
    expect(columnNames).toContain('lease_generation')
    expect(columnNames).toContain('completed_step_count')

    // Verify schema version
    const versions = await sql<{ version: number }>`
      SELECT version FROM durably_schema_versions ORDER BY version DESC LIMIT 1
    `.execute(durably.db)
    expect(versions.rows[0]?.version).toBe(LATEST_SCHEMA_VERSION)
    expect(LATEST_SCHEMA_VERSION).toBe(4)
  })

  it('creates all expected indexes', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(durably.db)

    await durably.migrate()

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_durably_%'
    `.execute(durably.db)
    const indexNames = indexes.rows.map((row) => row.name)

    // Runs indexes
    expect(indexNames).toContain('idx_durably_runs_job_idempotency')
    expect(indexNames).toContain('idx_durably_runs_status_concurrency')
    expect(indexNames).toContain('idx_durably_runs_status_created')
    expect(indexNames).toContain('idx_durably_runs_status_lease_expires')
    expect(indexNames).toContain('idx_durably_runs_job_created')
    expect(indexNames).toContain('idx_durably_runs_status_completed')
    expect(indexNames).toContain('idx_durably_runs_pending_concurrency')

    // Steps indexes
    expect(indexNames).toContain('idx_durably_steps_run_index')
    expect(indexNames).toContain('idx_durably_steps_completed_unique')
    expect(indexNames).toContain('idx_durably_step_attempts_run_started')
    expect(indexNames).toContain('idx_durably_waits_due')

    // Labels indexes
    expect(indexNames).toContain('idx_durably_run_labels_pk')
    expect(indexNames).toContain('idx_durably_run_labels_key_value')

    // Logs indexes
    expect(indexNames).toContain('idx_durably_logs_run_created')
  })

  it('upgrades a populated v1 database without changing existing runs or steps', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({ dialect: createLocalSqliteDialect(dbFile) })
    dbs.push(durably.db)

    await runMigrations(durably.db, { targetVersion: 1 })
    const run = await seedLegacyRun(durably.db)
    await durably.migrate()
    expect((await durably.storage.getRun(run.id))?.input).toEqual({ value: 1 })
    expect((await durably.storage.getSteps(run.id))[0].output).toBe(42)
    expect(await durably.storage.getStepAttempts(run.id)).toEqual([])
    const versions = await sql<{ version: number }>`
      SELECT version FROM durably_schema_versions ORDER BY version
    `.execute(durably.db)
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2, 3, 4])
  })

  it('upgrades v3 waits without inventing historical timing', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({ dialect: createLocalSqliteDialect(dbFile) })
    dbs.push(durably.db)
    await runMigrations(durably.db, { targetVersion: 3 })
    const now = new Date().toISOString()
    await sql`INSERT INTO durably_runs
      (id, job_name, input, status, labels, lease_generation,
       current_step_index, completed_step_count, created_at, updated_at)
      VALUES ('old-run', 'legacy', '{}', 'waiting', '{}', 1, 0, 0, ${now}, ${now})`.execute(
      durably.db,
    )
    for (const status of ['pending', 'resolved', 'cancelled', 'closed']) {
      const id = `old-${status}`
      const payload = status === 'resolved' ? 'true' : null
      const signalId = status === 'resolved' ? 'old-signal' : null
      const resolvedAt = status === 'pending' ? null : now
      await sql`INSERT INTO durably_waits
        (id, run_id, name, status, payload, signal_id, created_at, resolved_at)
        VALUES (${id}, 'old-run', ${id}, ${status}, ${payload}, ${signalId}, ${now}, ${resolvedAt})`.execute(
        durably.db,
      )
    }
    await durably.migrate()
    for (const status of ['pending', 'resolved', 'cancelled', 'closed']) {
      const wait = await durably.storage.getWait(`old-${status}`)
      expect(wait?.status).toBe(status)
      expect(wait?.outcome).toBe(status === 'resolved' ? 'signal' : null)
      expect(wait?.deadlineAt).toBeNull()
      expect(wait?.suspendedAt).toBeNull()
      expect(wait?.firstResumedAt).toBeNull()
      expect(wait?.inputWaitMs).toBeNull()
      expect(wait?.executionSlotWaitMs).toBeNull()
    }
  })
})
