import { createNodeDialect } from '../helpers/node-dialect'
import { createCoalesceTests } from '../shared/coalesce.shared'

createCoalesceTests(createNodeDialect)
