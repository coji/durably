import { createNodeDialect } from '../helpers/node-dialect'
import { createServerTests } from '../shared/server.shared'

createServerTests(createNodeDialect)
