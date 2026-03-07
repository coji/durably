import { PostgresDialect } from 'kysely'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

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
