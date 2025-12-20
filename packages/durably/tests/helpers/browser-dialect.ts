import { SQLocalKysely } from 'sqlocal/kysely'

let counter = 0

export function createBrowserDialect() {
  // Use unique DB name for each test (parallel test isolation)
  const dbName = `test-${Date.now()}-${counter++}.sqlite3`
  const { dialect } = new SQLocalKysely(dbName)
  return dialect
}
