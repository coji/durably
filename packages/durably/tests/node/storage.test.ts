import { createNodeDialect } from '../helpers/node-dialect'
import { createStorageTests } from '../shared/storage.shared'

createStorageTests(createNodeDialect)
