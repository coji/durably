import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createDbConcurrencyTests } from '../shared/db-concurrency.shared'

createDbConcurrencyTests('PostgreSQL', createPostgresSchemaResource)
