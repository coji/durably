/**
 * Database Configuration
 *
 * Turso/libSQL dialect for Vercel serverless.
 * - Production: Turso via TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
 * - Development: local libsqld via Docker (http://localhost:8080)
 *
 * Server-only - do not import in client code.
 */

import { LibsqlDialect } from '@libsql/kysely-libsql'

if (!process.env.TURSO_DATABASE_URL) {
  throw new Error('TURSO_DATABASE_URL is required. See .env.example')
}

export const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})
