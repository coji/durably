import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'
import { createDurableWaitTests } from '../shared/durable-waits.shared'

createDurableWaitTests(createLocalSqliteDialect)
