import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeDialectForFile } from '../helpers/node-dialect'
import { createDbStressTests } from '../shared/db-stress.shared'

createDbStressTests('libsql', () => {
  const filePath = join(tmpdir(), `durably-libsql-shared-${randomUUID()}.db`)

  return {
    createDialect: () => createNodeDialectForFile(filePath),
  }
})
