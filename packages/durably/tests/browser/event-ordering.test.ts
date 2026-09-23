import { createBrowserDialect } from '../helpers/browser-dialect'
import { createEventOrderingTests } from '../shared/event-ordering.shared'

createEventOrderingTests(createBrowserDialect)
