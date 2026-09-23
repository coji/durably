import { randomUUID } from 'node:crypto'

import { PostgresDialect } from 'kysely'
import pg from 'pg'
import { afterEach, beforeEach } from 'vitest'

const DEFAULT_POSTGRES_URL =
  'postgres://durably:durably@127.0.0.1:55432/durably'

interface PostgresDialectOptions {
  schema?: string
}

export function createPostgresDialect(options?: PostgresDialectOptions) {
  const connectionString =
    process.env.DURABLY_TEST_POSTGRES_URL ?? DEFAULT_POSTGRES_URL

  const pool = new pg.Pool({
    connectionString,
    max: 4,
    application_name: `durably-test-${randomUUID()}`,
    options: options?.schema ? `-c search_path=${options.schema}` : undefined,
  })

  return new PostgresDialect({ pool })
}

export function createPostgresSchemaResource() {
  const schema = `durably_${randomUUID().replace(/-/g, '')}`
  const connectionString =
    process.env.DURABLY_TEST_POSTGRES_URL ?? DEFAULT_POSTGRES_URL

  return {
    schema,
    createDialect: () => createPostgresDialect({ schema }),
    async setup() {
      const pool = new pg.Pool({ connectionString, max: 1 })
      try {
        await pool.query(`create schema if not exists "${schema}"`)
      } finally {
        await pool.end()
      }
    },
    async cleanup() {
      const pool = new pg.Pool({ connectionString, max: 1 })
      try {
        await pool.query(`drop schema if exists "${schema}" cascade`)
      } finally {
        await pool.end()
      }
    },
  }
}

/**
 * Give every test in the calling file its own schema.
 *
 * `claimNext` takes the oldest runnable run of any job, so a run left behind
 * by a failed or timed-out test would otherwise be claimed by the next test
 * that shares the schema, and one failure cascades through the file.
 */
export function usePostgresSchemaPerTest() {
  let resource: ReturnType<typeof createPostgresSchemaResource> | undefined
  beforeEach(async () => {
    // One slot per file: tests that ran concurrently would share it.
    if (resource) throw new Error('usePostgresSchemaPerTest needs serial tests')
    resource = createPostgresSchemaResource()
    await resource.setup()
  })
  afterEach(async () => {
    await resource?.cleanup()
    resource = undefined
  })
  return () => {
    if (!resource)
      throw new Error('Postgres schema is only available in a test')
    return resource.createDialect()
  }
}
