import { createPostgresDialect } from '../helpers/postgres-dialect'
import { createCoalesceTests } from '../shared/coalesce.shared'

createCoalesceTests(() => createPostgresDialect())
