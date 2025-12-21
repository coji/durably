import { createBrowserDialect } from '../helpers/browser-dialect'
import { createConcurrencyTests } from '../shared/concurrency.shared'

createConcurrencyTests(createBrowserDialect)
