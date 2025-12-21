import { createNodeDialect } from '../helpers/node-dialect'
import { createWorkerTests } from '../shared/worker.shared'

createWorkerTests(createNodeDialect)
