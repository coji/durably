import { usePostgresSchemaPerTest } from '../helpers/postgres-dialect'
import { createCoalesceTests } from '../shared/coalesce.shared'

createCoalesceTests(usePostgresSchemaPerTest())
