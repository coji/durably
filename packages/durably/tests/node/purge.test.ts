import { createNodeDialect } from '../helpers/node-dialect'
import { createPurgeTests } from '../shared/purge.shared'

createPurgeTests(createNodeDialect)
