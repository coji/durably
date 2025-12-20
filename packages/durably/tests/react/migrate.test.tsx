import { createBrowserDialect } from '../helpers/browser-dialect'
import { createMigrateTests } from '../shared/migrate.shared'

createMigrateTests(createBrowserDialect)
