import { createNodeDialect } from '../helpers/node-dialect'
import { createRunApiTests } from '../shared/run-api.shared'

createRunApiTests(createNodeDialect)
