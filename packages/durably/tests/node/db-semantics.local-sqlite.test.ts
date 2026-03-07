import { createLocalSqliteDialect } from '../helpers/local-sqlite-dialect'
import { createDbSemanticsTests } from '../shared/db-semantics.shared'

createDbSemanticsTests('local-sqlite', createLocalSqliteDialect)
