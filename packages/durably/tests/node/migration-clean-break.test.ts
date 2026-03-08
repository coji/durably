import { Kysely, sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably } from '../../src'
import { LATEST_SCHEMA_VERSION } from '../../src/migrations'
import type { Database } from '../../src/schema'
import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'

describe('migration clean break', () => {
  const dbs: Array<Kysely<Database>> = []

  afterEach(async () => {
    await Promise.all(dbs.map((db) => db.destroy()))
  })

  it('upgrades a v2-style database by dropping heartbeat_at', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const legacyDb = new Kysely<Database>({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(legacyDb)

    await sql`
      CREATE TABLE durably_runs (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT,
        concurrency_key TEXT,
        labels TEXT NOT NULL DEFAULT '{}',
        current_step_index INTEGER NOT NULL DEFAULT 0,
        progress TEXT,
        output TEXT,
        error TEXT,
        heartbeat_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `.execute(legacyDb)

    await sql`
      CREATE UNIQUE INDEX idx_durably_runs_job_idempotency
      ON durably_runs (job_name, idempotency_key)
    `.execute(legacyDb)
    await sql`
      CREATE INDEX idx_durably_runs_status_concurrency
      ON durably_runs (status, concurrency_key)
    `.execute(legacyDb)
    await sql`
      CREATE INDEX idx_durably_runs_status_created
      ON durably_runs (status, created_at)
    `.execute(legacyDb)
    await sql`
      CREATE INDEX idx_durably_runs_status_lease_expires
      ON durably_runs (status, lease_expires_at)
    `.execute(legacyDb)

    await sql`
      CREATE TABLE durably_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        "index" INTEGER NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )
    `.execute(legacyDb)
    await sql`
      CREATE INDEX idx_durably_steps_run_index
      ON durably_steps (run_id, "index")
    `.execute(legacyDb)

    await sql`
      CREATE TABLE durably_logs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_name TEXT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      )
    `.execute(legacyDb)
    await sql`
      CREATE INDEX idx_durably_logs_run_created
      ON durably_logs (run_id, created_at)
    `.execute(legacyDb)

    await sql`
      CREATE TABLE durably_schema_versions (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `.execute(legacyDb)

    await sql`
      INSERT INTO durably_runs (
        id, job_name, input, status, idempotency_key, concurrency_key, labels,
        current_step_index, progress, output, error, heartbeat_at, lease_owner,
        lease_expires_at, started_at, completed_at, created_at, updated_at
      ) VALUES (
        'run-1', 'legacy-job', '{}', 'completed', NULL, NULL, '{}',
        1, NULL, '{"ok":true}', NULL, '2026-03-08T00:00:00.000Z', NULL,
        NULL, '2026-03-08T00:00:00.000Z', '2026-03-08T00:00:01.000Z',
        '2026-03-08T00:00:00.000Z', '2026-03-08T00:00:01.000Z'
      )
    `.execute(legacyDb)

    await sql`
      INSERT INTO durably_schema_versions (version, applied_at)
      VALUES (2, '2026-03-08T00:00:00.000Z')
    `.execute(legacyDb)

    const durably = createDurably({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(durably.db)

    await durably.migrate()

    const columns = await sql<{ name: string }>`
      PRAGMA table_info('durably_runs')
    `.execute(durably.db)
    const versions = await sql<{ version: number }>`
      SELECT version FROM durably_schema_versions ORDER BY version DESC LIMIT 1
    `.execute(durably.db)
    const run = await durably.getRun('run-1')

    expect(columns.rows.map((row) => row.name)).not.toContain('heartbeat_at')
    expect(versions.rows[0]?.version).toBe(LATEST_SCHEMA_VERSION)
    expect(run?.status).toBe('completed')
    expect(run?.output).toEqual({ ok: true })
  })
})
