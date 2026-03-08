import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'
import { createDbStressTests } from '../shared/db-stress.shared'

createDbStressTests('local-sqlite', () => {
  const filePath = join(
    tmpdir(),
    `durably-local-shared-${randomUUID()}.sqlite3`,
  )

  return {
    createDialect: () => createLocalSqliteDialect(filePath),
    cleanup: async () => {
      await rm(filePath, { force: true })
    },
  }
})
