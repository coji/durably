import { usePostgresSchemaPerTest } from '../helpers/postgres-dialect'
import { createDurableWaitTests } from '../shared/durable-waits.shared'
createDurableWaitTests(usePostgresSchemaPerTest())
