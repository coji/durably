import type { Dialect } from 'kysely'
import { Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'

export function createSetupTests(createDialect: () => Dialect) {
  describe('Basic Setup', () => {
    it('can create a Kysely instance with the dialect', async () => {
      const dialect = createDialect()
      const db = new Kysely<object>({ dialect })

      expect(db).toBeDefined()

      await db.destroy()
    })

    it('can execute a simple query', async () => {
      const dialect = createDialect()
      const db = new Kysely<object>({ dialect })

      const result = await sql<{ value: number }>`SELECT 1 as value`.execute(db)

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].value).toBe(1)

      await db.destroy()
    })
  })
}
