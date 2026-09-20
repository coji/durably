import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

createWaitStorageTests(createLocalSqliteDialect)
