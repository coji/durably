import { LibsqlDialect } from '@libsql/kysely-libsql'

export function createNodeDialect() {
  return new LibsqlDialect({
    url: ':memory:',
  })
}
