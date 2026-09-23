import { usePostgresSchemaPerTest } from '../helpers/postgres-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

createWaitStorageTests(usePostgresSchemaPerTest())
