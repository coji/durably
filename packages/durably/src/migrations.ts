import type { Kysely } from 'kysely'
import type { Database } from './schema'

/**
 * Migration definitions
 */
interface Migration {
  version: number
  up: (db: Kysely<Database>) => Promise<void>
}

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
        .addColumn('payload', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('idempotency_key', 'text')
        .addColumn('concurrency_key', 'text')
        .addColumn('current_step_index', 'integer', (col) =>
          col.notNull().defaultTo(0),
        )
        .addColumn('progress', 'text')
        .addColumn('output', 'text')
        .addColumn('error', 'text')
        .addColumn('heartbeat_at', 'text', (col) => col.notNull())
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

      // Create steps index
      await db.schema
        .createIndex('idx_durably_steps_run_index')
        .ifNotExists()
        .on('durably_steps')
        .columns(['run_id', 'index'])
        .execute()

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
      await migration.up(db)

      await db
        .insertInto('durably_schema_versions')
        .values({
          version: migration.version,
          applied_at: new Date().toISOString(),
        })
        .execute()
    }
  }
}
