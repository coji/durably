import { createBrowserDialect } from '../helpers/browser-dialect'
import { createDbSemanticsTests } from '../shared/db-semantics.shared'

createDbSemanticsTests('sqlocal', createBrowserDialect)
