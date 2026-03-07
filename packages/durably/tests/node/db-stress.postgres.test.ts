import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createDbStressTests } from '../shared/db-stress.shared'

createDbStressTests('postgres', () => createPostgresSchemaResource())
