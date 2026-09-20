import { createBrowserDialect } from '../helpers/browser-dialect'
import { createDurableWaitTests } from '../shared/durable-waits.shared'

createDurableWaitTests(createBrowserDialect)
