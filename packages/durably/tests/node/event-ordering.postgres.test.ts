import { usePostgresSchemaPerTest } from '../helpers/postgres-dialect'
import { createEventOrderingTests } from '../shared/event-ordering.shared'

createEventOrderingTests(usePostgresSchemaPerTest())
