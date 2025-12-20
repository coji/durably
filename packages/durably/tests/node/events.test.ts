import { createNodeDialect } from '../helpers/node-dialect'
import { createEventsTests } from '../shared/events.shared'

createEventsTests(createNodeDialect)
