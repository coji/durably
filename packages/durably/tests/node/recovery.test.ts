import { createNodeDialect } from '../helpers/node-dialect'
import { createRecoveryTests } from '../shared/recovery.shared'

createRecoveryTests(createNodeDialect)
