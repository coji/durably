import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LibsqlDialect } from '@libsql/kysely-libsql'

export function createNodeDialect() {
  // Use temp file instead of :memory: for libsql transaction compatibility
  const tempFile = join(tmpdir(), `durably-test-${randomUUID()}.db`)
  return new LibsqlDialect({
    url: `file:${tempFile}`,
  })
}

export function createNodeDialectForFile(filePath: string) {
  return new LibsqlDialect({
    url: `file:${filePath}`,
  })
}
