import { createNodeDialect } from '../helpers/node-dialect'
import { createMigrateTests } from '../shared/migrate.shared'

createMigrateTests(createNodeDialect)
