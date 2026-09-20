import { createNodeDialect } from '../helpers/node-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

createWaitStorageTests(createNodeDialect)
