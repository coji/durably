import { createNodeDialect } from '../helpers/node-dialect'
import { createEventOrderingTests } from '../shared/event-ordering.shared'

createEventOrderingTests(createNodeDialect)
