import { createNodeDialect } from '../helpers/node-dialect'
import { createDurablyTests } from '../shared/durably.shared'

createDurablyTests(createNodeDialect)
