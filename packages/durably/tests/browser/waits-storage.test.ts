import { createBrowserDialect } from '../helpers/browser-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

createWaitStorageTests(createBrowserDialect)
