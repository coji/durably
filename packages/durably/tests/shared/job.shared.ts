import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably } from '../../src'

export function createJobTests(createDialect: () => Dialect) {
  describe('defineJob()', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('returns a JobHandle', () => {
      const job = durably.defineJob(
        {
          name: 'test-job',
          input: z.object({ value: z.number() }),
          output: z.object({ result: z.number() }),
        },
        async (_ctx, _payload) => {
          return { result: 42 }
        }
      )

      expect(job).toBeDefined()
      expect(job.name).toBe('test-job')
      expect(job.trigger).toBeTypeOf('function')
      expect(job.getRun).toBeTypeOf('function')
      expect(job.getRuns).toBeTypeOf('function')
    })

    it('throws if job name is already registered', () => {
      durably.defineJob(
        {
          name: 'duplicate-job',
          input: z.object({}),
          output: z.object({}),
        },
        async () => ({})
      )

      expect(() => {
        durably.defineJob(
          {
            name: 'duplicate-job',
            input: z.object({}),
            output: z.object({}),
          },
          async () => ({})
        )
      }).toThrow(/already registered|duplicate/i)
    })

    it('validates input with Zod schema on trigger', async () => {
      const job = durably.defineJob(
        {
          name: 'validated-job',
          input: z.object({ count: z.number().min(1) }),
          output: z.object({}),
        },
        async () => ({})
      )

      // Invalid input should throw
      await expect(
        job.trigger({ count: 0 } as { count: number })
      ).rejects.toThrow()

      await expect(
        job.trigger({ count: -1 } as { count: number })
      ).rejects.toThrow()
    })

    it('accepts valid input on trigger', async () => {
      const job = durably.defineJob(
        {
          name: 'valid-input-job',
          input: z.object({ count: z.number().min(1) }),
          output: z.object({}),
        },
        async () => ({})
      )

      // Valid input should work
      const run = await job.trigger({ count: 1 })
      expect(run).toBeDefined()
      expect(run.id).toBeDefined()
      expect(run.status).toBe('pending')
    })

    it('infers input type from Zod schema', async () => {
      const job = durably.defineJob(
        {
          name: 'typed-input-job',
          input: z.object({
            name: z.string(),
            count: z.number(),
            optional: z.boolean().optional(),
          }),
          output: z.object({ success: z.boolean() }),
        },
        async (_ctx, payload) => {
          // Type inference test - this should compile
          const _name: string = payload.name
          const _count: number = payload.count
          const _optional: boolean | undefined = payload.optional
          return { success: true }
        }
      )

      const run = await job.trigger({
        name: 'test',
        count: 42,
      })

      expect(run.status).toBe('pending')
    })

    it('can define job without output schema (defaults to void)', async () => {
      const job = durably.defineJob(
        {
          name: 'no-output-job',
          input: z.object({ value: z.string() }),
        },
        async (_ctx, _payload) => {
          // No return value
        }
      )

      const run = await job.trigger({ value: 'test' })
      expect(run.status).toBe('pending')
    })
  })
}
