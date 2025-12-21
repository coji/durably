import { createNodeDialect } from '../helpers/node-dialect'
import { createConcurrencyTests } from '../shared/concurrency.shared'

createConcurrencyTests(createNodeDialect)
