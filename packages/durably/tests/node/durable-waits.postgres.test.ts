import { afterAll, beforeAll } from 'vitest'
import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createDurableWaitTests } from '../shared/durable-waits.shared'
const resource = createPostgresSchemaResource()
beforeAll(() => resource.setup())
afterAll(() => resource.cleanup())
createDurableWaitTests(() => resource.createDialect())
