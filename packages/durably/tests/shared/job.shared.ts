import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob, type Durably } from '../../src'

export function createJobTests(createDialect: () => Dialect) {
  describe('register()', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('returns a JobHandle', () => {
      const testJobDef = defineJob({
        name: 'test-job',
        input: z.object({ value: z.number() }),
        output: z.object({ result: z.number() }),
        run: async (_step, _payload) => {
          return { result: 42 }
        },
      })
      const job = durably.register(testJobDef)

      expect(job).toBeDefined()
      expect(job.name).toBe('test-job')
      expect(job.trigger).toBeTypeOf('function')
      expect(job.getRun).toBeTypeOf('function')
      expect(job.getRuns).toBeTypeOf('function')
    })

    it('returns same JobHandle for same JobDefinition (idempotent)', () => {
      const jobDef = defineJob({
        name: 'idempotent-job',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      })

      const handle1 = durably.register(jobDef)
      const handle2 = durably.register(jobDef)

      expect(handle1).toBe(handle2)
    })

    it('throws if different JobDefinition has same name', () => {
      const jobDef1 = defineJob({
        name: 'conflict-job',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      })

      const jobDef2 = defineJob({
        name: 'conflict-job',
        input: z.object({}),
        output: z.object({}),
        run: async () => ({}),
      })

      durably.register(jobDef1)

      expect(() => {
        durably.register(jobDef2)
      }).toThrow(/already registered|different/i)
    })

    it('validates input with Zod schema on trigger', async () => {
      const validatedJobDef = defineJob({
        name: 'validated-job',
        input: z.object({ count: z.number().min(1) }),
        output: z.object({}),
        run: async () => ({}),
      })
      const job = durably.register(validatedJobDef)

      // Invalid input should throw
      await expect(
        job.trigger({ count: 0 } as { count: number }),
      ).rejects.toThrow()

      await expect(
        job.trigger({ count: -1 } as { count: number }),
      ).rejects.toThrow()
    })

    it('accepts valid input on trigger', async () => {
      const validInputJobDef = defineJob({
        name: 'valid-input-job',
        input: z.object({ count: z.number().min(1) }),
        output: z.object({}),
        run: async () => ({}),
      })
      const job = durably.register(validInputJobDef)

      // Valid input should work
      const run = await job.trigger({ count: 1 })
      expect(run).toBeDefined()
      expect(run.id).toBeDefined()
      expect(run.status).toBe('pending')
    })

    it('infers input type from Zod schema', async () => {
      const typedInputJobDef = defineJob({
        name: 'typed-input-job',
        input: z.object({
          name: z.string(),
          count: z.number(),
          optional: z.boolean().optional(),
        }),
        output: z.object({ success: z.boolean() }),
        run: async (_step, payload) => {
          // Type inference test - this should compile
          const _name: string = payload.name
          const _count: number = payload.count
          const _optional: boolean | undefined = payload.optional
          return { success: true }
        },
      })
      const job = durably.register(typedInputJobDef)

      const run = await job.trigger({
        name: 'test',
        count: 42,
      })

      expect(run.status).toBe('pending')
    })

    it('can define job without output schema (defaults to void)', async () => {
      const noOutputJobDef = defineJob({
        name: 'no-output-job',
        input: z.object({ value: z.string() }),
        run: async (_step, _payload) => {
          // No return value
        },
      })
      const job = durably.register(noOutputJobDef)

      const run = await job.trigger({ value: 'test' })
      expect(run.status).toBe('pending')
    })
  })

  describe('batchTrigger()', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('creates multiple runs in a single call', async () => {
      const batchJobDef = defineJob({
        name: 'batch-job',
        input: z.object({ value: z.number() }),
        run: async () => {},
      })
      const job = durably.register(batchJobDef)

      const runs = await job.batchTrigger([
        { value: 1 },
        { value: 2 },
        { value: 3 },
      ])

      expect(runs).toHaveLength(3)
      expect(runs[0].status).toBe('pending')
      expect(runs[1].status).toBe('pending')
      expect(runs[2].status).toBe('pending')

      // Verify all runs exist in DB
      const allRuns = await job.getRuns()
      expect(allRuns).toHaveLength(3)
    })

    it('validates all inputs before creating any runs', async () => {
      const batchValidateJobDef = defineJob({
        name: 'batch-validate-job',
        input: z.object({ value: z.number().min(1) }),
        run: async () => {},
      })
      const job = durably.register(batchValidateJobDef)

      // Second input is invalid (0 < min 1)
      await expect(
        job.batchTrigger([{ value: 5 }, { value: 0 }, { value: 3 }]),
      ).rejects.toThrow()

      // No runs should have been created
      const allRuns = await job.getRuns()
      expect(allRuns).toHaveLength(0)
    })

    it('accepts trigger options for each input', async () => {
      const batchOptionsJobDef = defineJob({
        name: 'batch-options-job',
        input: z.object({ id: z.string() }),
        run: async () => {},
      })
      const job = durably.register(batchOptionsJobDef)

      const runs = await job.batchTrigger([
        { input: { id: 'a' }, options: { idempotencyKey: 'key-a' } },
        { input: { id: 'b' }, options: { concurrencyKey: 'group-1' } },
        { input: { id: 'c' } },
      ])

      expect(runs).toHaveLength(3)
      expect(runs[0].idempotencyKey).toBe('key-a')
      expect(runs[1].concurrencyKey).toBe('group-1')
    })

    it('returns empty array for empty input', async () => {
      const batchEmptyJobDef = defineJob({
        name: 'batch-empty-job',
        input: z.object({}),
        run: async () => {},
      })
      const job = durably.register(batchEmptyJobDef)

      const runs = await job.batchTrigger([])
      expect(runs).toEqual([])
    })
  })
}
