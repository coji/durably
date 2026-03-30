/**
 * Database Configuration
 *
 * PostgreSQL dialect for multi-worker deployments.
 * Set DATABASE_URL environment variable to connect.
 */

import { PostgresDialect } from 'kysely'
import pg from 'pg'

export const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString:
      process.env.DATABASE_URL ?? 'postgresql://localhost:5432/durably',
  }),
})
