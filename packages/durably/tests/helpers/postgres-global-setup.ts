import { PostgreSqlContainer } from '@testcontainers/postgresql'

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined

export async function setup() {
  // Skip if a PostgreSQL URL is already provided (e.g., CI with external DB)
  if (process.env.DURABLY_TEST_POSTGRES_URL) return

  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DURABLY_TEST_POSTGRES_URL = container.getConnectionUri()
}

export async function teardown() {
  await container?.stop()
}
