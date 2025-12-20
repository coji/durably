import { createBrowserDialect } from '../helpers/browser-dialect'
import { createWorkerTests } from '../shared/worker.shared'

createWorkerTests(createBrowserDialect)
