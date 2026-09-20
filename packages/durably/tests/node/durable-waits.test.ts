import { createNodeDialect } from '../helpers/node-dialect'
import { createDurableWaitTests } from '../shared/durable-waits.shared'

createDurableWaitTests(createNodeDialect)
