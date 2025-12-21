import type { Dialect } from 'kysely'
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'

export function createMigrateTests(createDialect: () => Dialect) {
  describe('migrate()', () => {
    let durably: Durably

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('creates durably_runs table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_runs'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_runs')
    })

    it('creates durably_steps table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_steps'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_steps')
    })

    it('creates durably_logs table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_logs'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_logs')
    })

    it('creates durably_schema_versions table', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type='table' AND name='durably_schema_versions'
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('durably_schema_versions')
    })

    it('records schema version after migration', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      const result = await sql<{ version: number }>`
        SELECT version FROM durably_schema_versions ORDER BY version DESC LIMIT 1
      `.execute(durably.db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].version).toBe(1)
    })

    it('is idempotent (can be called multiple times safely)', async () => {
      durably = createDurably({ dialect: createDialect() })

      await durably.migrate()
      await durably.migrate()
      await durably.migrate()

      const result = await sql<{ version: number }>`
        SELECT version FROM durably_schema_versions
      `.execute(durably.db)

      // Should only have one version record
      expect(result.rows).toHaveLength(1)
    })
  })
}
