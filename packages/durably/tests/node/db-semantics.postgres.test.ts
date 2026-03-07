import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createDbSemanticsTests } from '../shared/db-semantics.shared'

createDbSemanticsTests('postgres', createPostgresSchemaResource())
