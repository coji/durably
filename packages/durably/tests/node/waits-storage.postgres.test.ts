import { afterEach, beforeEach } from 'vitest'

import { createPostgresSchemaResource } from '../helpers/postgres-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

let resource: ReturnType<typeof createPostgresSchemaResource>
beforeEach(async () => {
  resource = createPostgresSchemaResource()
  await resource.setup()
})
afterEach(async () => {
  await resource.cleanup()
})
createWaitStorageTests(() => resource.createDialect())
