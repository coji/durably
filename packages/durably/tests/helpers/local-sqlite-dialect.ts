import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function createLocalSqliteDialect(filename?: string) {
  const dbFile =
    filename ?? join(tmpdir(), `durably-local-${randomUUID()}.sqlite3`)

  const sqlite = new Database(dbFile)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')

  return new SqliteDialect({
    database: sqlite,
  })
}
