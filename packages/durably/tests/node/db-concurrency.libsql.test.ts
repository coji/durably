import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeDialectForFile } from '../helpers/node-dialect'
import { createDbConcurrencyTests } from '../shared/db-concurrency.shared'

createDbConcurrencyTests('libSQL', () => {
  const dbFile = join(tmpdir(), `durably-concurrency-${randomUUID()}.db`)
  return {
    createDialect: () => createNodeDialectForFile(dbFile),
  }
})
