import { afterAll, beforeAll } from 'vitest'
import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createCoalesceTests } from '../shared/coalesce.shared'

const resource = createPostgresSchemaResource()

beforeAll(async () => {
  await resource.setup()
})

afterAll(async () => {
  await resource.cleanup()
})

createCoalesceTests(() => resource.createDialect())
