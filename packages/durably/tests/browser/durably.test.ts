import { createBrowserDialect } from '../helpers/browser-dialect'
import { createDurablyTests } from '../shared/durably.shared'

createDurablyTests(createBrowserDialect)
