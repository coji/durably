import { Kysely, sql } from 'kysely'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably } from '../../src'
import { LATEST_SCHEMA_VERSION } from '../../src/migrations'
import type { Database } from '../../src/schema'
import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'

describe('migration consolidated schema', () => {
  const dbs: Array<Kysely<Database>> = []

  afterEach(async () => {
    await Promise.all(dbs.map((db) => db.destroy()))
  })

  it('creates all tables with correct columns in a single migration', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(durably.db)

    await durably.migrate()

    // Verify runs table has lease columns and no heartbeat_at
    const runsColumns = await sql<{ name: string }>`
      PRAGMA table_info('durably_runs')
    `.execute(durably.db)
    const columnNames = runsColumns.rows.map((row) => row.name)
    expect(columnNames).toContain('lease_owner')
    expect(columnNames).toContain('lease_expires_at')
    expect(columnNames).toContain('lease_generation')

    // Verify schema version
    const versions = await sql<{ version: number }>`
      SELECT version FROM durably_schema_versions ORDER BY version DESC LIMIT 1
    `.execute(durably.db)
    expect(versions.rows[0]?.version).toBe(LATEST_SCHEMA_VERSION)
    expect(LATEST_SCHEMA_VERSION).toBe(1)
  })

  it('creates partial unique index on completed steps', async () => {
    const dbFile = join(tmpdir(), `durably-migrate-${randomUUID()}.sqlite3`)
    const durably = createDurably({
      dialect: createLocalSqliteDialect(dbFile),
    })
    dbs.push(durably.db)

    await durably.migrate()

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND name='idx_durably_steps_completed_unique'
    `.execute(durably.db)
    expect(indexes.rows).toHaveLength(1)
  })
})
