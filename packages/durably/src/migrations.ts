import { type Kysely, sql } from 'kysely'
import type { Database } from './schema'

/**
 * Migration definitions
 */
interface Migration {
  version: number
  up: (db: Kysely<Database>) => Promise<void>
}

export const LATEST_SCHEMA_VERSION = 1

const migrations: Migration[] = [
  {
    version: 1,
    up: async (db) => {
      // Create runs table
      await db.schema
        .createTable('durably_runs')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('job_name', 'text', (col) => col.notNull())
        .addColumn('input', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('idempotency_key', 'text')
        .addColumn('concurrency_key', 'text')
        .addColumn('labels', 'text', (col) => col.notNull().defaultTo('{}'))
        .addColumn('current_step_index', 'integer', (col) =>
          col.notNull().defaultTo(0),
        )
        .addColumn('progress', 'text')
        .addColumn('output', 'text')
        .addColumn('error', 'text')
        .addColumn('lease_owner', 'text')
        .addColumn('lease_expires_at', 'text')
        .addColumn('lease_generation', 'integer', (col) =>
          col.notNull().defaultTo(0),
        )
        .addColumn('started_at', 'text')
        .addColumn('completed_at', 'text')
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('updated_at', 'text', (col) => col.notNull())
        .execute()

      // Create runs indexes
      await db.schema
        .createIndex('idx_durably_runs_job_idempotency')
        .ifNotExists()
        .on('durably_runs')
        .columns(['job_name', 'idempotency_key'])
        .unique()
        .execute()

      await db.schema
        .createIndex('idx_durably_runs_status_concurrency')
        .ifNotExists()
        .on('durably_runs')
        .columns(['status', 'concurrency_key'])
        .execute()

      await db.schema
        .createIndex('idx_durably_runs_status_created')
        .ifNotExists()
        .on('durably_runs')
        .columns(['status', 'created_at'])
        .execute()

      await db.schema
        .createIndex('idx_durably_runs_status_lease_expires')
        .ifNotExists()
        .on('durably_runs')
        .columns(['status', 'lease_expires_at'])
        .execute()

      await db.schema
        .createIndex('idx_durably_runs_job_created')
        .ifNotExists()
        .on('durably_runs')
        .columns(['job_name', 'created_at'])
        .execute()

      // Create normalized labels table for indexed label filtering
      await db.schema
        .createTable('durably_run_labels')
        .ifNotExists()
        .addColumn('run_id', 'text', (col) => col.notNull())
        .addColumn('key', 'text', (col) => col.notNull())
        .addColumn('value', 'text', (col) => col.notNull())
        .execute()

      await db.schema
        .createIndex('idx_durably_run_labels_pk')
        .ifNotExists()
        .on('durably_run_labels')
        .columns(['run_id', 'key'])
        .unique()
        .execute()

      await db.schema
        .createIndex('idx_durably_run_labels_key_value')
        .ifNotExists()
        .on('durably_run_labels')
        .columns(['key', 'value'])
        .execute()

      // Create steps table
      await db.schema
        .createTable('durably_steps')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('run_id', 'text', (col) => col.notNull())
        .addColumn('name', 'text', (col) => col.notNull())
        .addColumn('index', 'integer', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('output', 'text')
        .addColumn('error', 'text')
        .addColumn('started_at', 'text', (col) => col.notNull())
        .addColumn('completed_at', 'text')
        .execute()

      // Create steps indexes
      await db.schema
        .createIndex('idx_durably_steps_run_index')
        .ifNotExists()
        .on('durably_steps')
        .columns(['run_id', 'index'])
        .execute()

      // Partial unique index: completed steps must be unique per (run_id, name).
      // This guarantees deterministic replay — getCompletedStep(runId, name)
      // returns at most one row. Failed/cancelled steps are not constrained
      // so retries within the same run can re-execute a previously failed step.
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_durably_steps_completed_unique
        ON durably_steps(run_id, name) WHERE status = 'completed'
      `.execute(db)

      // Create logs table
      await db.schema
        .createTable('durably_logs')
        .ifNotExists()
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('run_id', 'text', (col) => col.notNull())
        .addColumn('step_name', 'text')
        .addColumn('level', 'text', (col) => col.notNull())
        .addColumn('message', 'text', (col) => col.notNull())
        .addColumn('data', 'text')
        .addColumn('created_at', 'text', (col) => col.notNull())
        .execute()

      // Create logs index
      await db.schema
        .createIndex('idx_durably_logs_run_created')
        .ifNotExists()
        .on('durably_logs')
        .columns(['run_id', 'created_at'])
        .execute()

      // Create schema_versions table
      await db.schema
        .createTable('durably_schema_versions')
        .ifNotExists()
        .addColumn('version', 'integer', (col) => col.primaryKey())
        .addColumn('applied_at', 'text', (col) => col.notNull())
        .execute()
    },
  },
]

/**
 * Get the current schema version from the database
 */
async function getCurrentVersion(db: Kysely<Database>): Promise<number> {
  try {
    const result = await db
      .selectFrom('durably_schema_versions')
      .select('version')
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst()

    return result?.version ?? 0
  } catch {
    // Table doesn't exist yet
    return 0
  }
}

/**
 * Run pending migrations
 */
export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const currentVersion = await getCurrentVersion(db)

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      await db.transaction().execute(async (trx) => {
        await migration.up(trx)

        await trx
          .insertInto('durably_schema_versions')
          .values({
            version: migration.version,
            applied_at: new Date().toISOString(),
          })
          .execute()
      })
    }
  }
}
