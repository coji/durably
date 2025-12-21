import type { Dialect } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'

export function createDurablyTests(createDialect: () => Dialect) {
  describe('createDurably()', () => {
    let durably: Durably

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('returns a Durably instance', () => {
      durably = createDurably({ dialect: createDialect() })

      expect(durably).toBeDefined()
      expect(durably.db).toBeDefined()
      expect(durably.storage).toBeDefined()
      expect(durably.migrate).toBeTypeOf('function')
      expect(durably.on).toBeTypeOf('function')
      expect(durably.emit).toBeTypeOf('function')
    })

    it('applies default configuration values', () => {
      durably = createDurably({ dialect: createDialect() })

      // Default values should be applied internally
      // We can't directly test internal config, but we verify instance creation works
      expect(durably).toBeDefined()
    })

    it('accepts custom configuration values', () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 2000,
        heartbeatInterval: 10000,
        staleThreshold: 60000,
      })

      // Custom values should be applied internally
      // We can't directly test internal config, but we verify instance creation works
      expect(durably).toBeDefined()
    })

    it('exposes the underlying Kysely database instance', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      // Can use db directly for queries
      const result = await durably.db
        .selectFrom('durably_runs')
        .selectAll()
        .execute()
      expect(result).toEqual([])
    })

    it('exposes the storage layer', async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()

      // Can use storage directly
      const run = await durably.storage.createRun({
        jobName: 'test-job',
        payload: { test: true },
      })

      expect(run.id).toBeDefined()
      expect(run.jobName).toBe('test-job')
    })
  })
}
