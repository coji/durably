/**
 * Database Configuration
 *
 * libSQL dialect for server-side SQLite.
 * Server-only - do not import in client code.
 */

import { LibsqlDialect } from '@libsql/kysely-libsql'

export const dialect = new LibsqlDialect({
  url: process.env.DATABASE_URL ?? 'file:./local.db',
})
