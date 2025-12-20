import type { Kysely } from 'kysely'
import { sql } from 'kysely'
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
        .createTable('runs')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('job_name', 'text', (col) => col.notNull())
        .addColumn('payload', 'text', (col) => col.notNull())
        .addColumn('status', 'text', (col) => col.notNull())
        .addColumn('idempotency_key', 'text')
        .addColumn('concurrency_key', 'text')
        .addColumn('current_step_index', 'integer', (col) => col.notNull().defaultTo(0))
        .addColumn('progress', 'text')
        .addColumn('output', 'text')
        .addColumn('error', 'text')
        .addColumn('heartbeat_at', 'text', (col) => col.notNull())
        .addColumn('created_at', 'text', (col) => col.notNull())
        .addColumn('updated_at', 'text', (col) => col.notNull())
        .execute()

      // Create runs indexes
      await db.schema
        .createIndex('idx_runs_job_idempotency')
        .on('runs')
        .columns(['job_name', 'idempotency_key'])
        .unique()
        .execute()

      await db.schema
        .createIndex('idx_runs_status_concurrency')
        .on('runs')
        .columns(['status', 'concurrency_key'])
        .execute()

      await db.schema
        .createIndex('idx_runs_status_created')
        .on('runs')
        .columns(['status', 'created_at'])
        .execute()

      // Create steps table
      await db.schema
        .createTable('steps')
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
        .createIndex('idx_steps_run_index')
        .on('steps')
        .columns(['run_id', 'index'])
        .execute()

      // Create logs table
      await db.schema
        .createTable('logs')
        .addColumn('id', 'text', (col) => col.primaryKey())
        .addColumn('run_id', 'text', (col) => col.notNull())
        .addColumn('step_name', 'text')
        .addColumn('level', 'text', (col) => col.notNull())
        .addColumn('message', 'text', (col) => col.notNull())
        .addColumn('data', 'text')
        .addColumn('timestamp', 'text', (col) => col.notNull())
        .execute()

      // Create logs index
      await db.schema
        .createIndex('idx_logs_run_timestamp')
        .on('logs')
        .columns(['run_id', 'timestamp'])
        .execute()

      // Create schema_versions table
      await db.schema
        .createTable('schema_versions')
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
      .selectFrom('schema_versions')
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
        .insertInto('schema_versions')
        .values({
          version: migration.version,
          applied_at: new Date().toISOString(),
        })
        .execute()
    }
  }
}
