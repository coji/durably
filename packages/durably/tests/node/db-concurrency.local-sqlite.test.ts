import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'
import { createDbConcurrencyTests } from '../shared/db-concurrency.shared'

createDbConcurrencyTests('local SQLite', () => {
  const dbFile = join(tmpdir(), `durably-concurrency-${randomUUID()}.sqlite3`)
  return {
    createDialect: () => createLocalSqliteDialect(dbFile),
  }
})
