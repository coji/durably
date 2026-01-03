/**
 * Database Configuration
 *
 * libSQL/Turso dialect for server-side SQLite.
 * Uses environment variables for Turso connection, falls back to local file.
 */

import { LibsqlDialect } from '@libsql/kysely-libsql'

export const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})
