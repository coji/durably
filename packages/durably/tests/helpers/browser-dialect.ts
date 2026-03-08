import { SQLocalKysely } from 'sqlocal/kysely'

let counter = 0
const BROWSER_LOCAL_DIALECT_KEY = '__durablyBrowserLocalKey'

export function createBrowserDialect() {
  // Use unique DB name for each test (parallel test isolation)
  const dbName = `test-${Date.now()}-${counter++}.sqlite3`
  return createBrowserDialectForName(dbName)
}

export function createBrowserDialectForName(dbName: string) {
  const { dialect } = new SQLocalKysely(dbName)
  Object.defineProperty(dialect, BROWSER_LOCAL_DIALECT_KEY, {
    value: `sqlocal:${dbName}`,
    configurable: true,
  })
  return dialect
}
