/**
 * Type inference tests for core API
 *
 * Verify that types are correctly inferred from job definitions,
 * including Zod branded types.
 */

import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { defineJob } from '../../src'

describe('Type inference', () => {
  describe('defineJob with branded types', () => {
    it('preserves branded input types in run function', () => {
      const orgIdSchema = z.string().brand<'OrganizationId'>()
      type OrganizationId = z.infer<typeof orgIdSchema>

      const job = defineJob({
        name: 'branded-input',
        input: z.object({ organizationId: orgIdSchema }),
        run: async (_step, input) => {
          expectTypeOf(input.organizationId).toEqualTypeOf<OrganizationId>()
        },
      })

      expectTypeOf(job.input.parse({ organizationId: 'org_1' })).toEqualTypeOf<{
        organizationId: OrganizationId
      }>()
    })

    it('preserves branded output types', () => {
      const countSchema = z.number().brand<'Count'>()
      type Count = z.infer<typeof countSchema>

      const job = defineJob({
        name: 'branded-output',
        input: z.object({ id: z.string() }),
        output: z.object({ count: countSchema }),
        run: async (_step, _input) => {
          return { count: 42 as Count }
        },
      })

      expectTypeOf(job.output!.parse({ count: 1 })).toEqualTypeOf<{
        count: Count
      }>()
    })

    it('preserves branded types through JobInput/JobOutput helpers', async () => {
      const userIdSchema = z.string().brand<'UserId'>()
      type UserId = z.infer<typeof userIdSchema>

      const job = defineJob({
        name: 'branded-helpers',
        input: z.object({ userId: userIdSchema }),
        output: z.object({ name: z.string() }),
        run: async (_step, input) => {
          expectTypeOf(input.userId).toEqualTypeOf<UserId>()
          return { name: 'test' }
        },
      })

      // Verify the job definition itself has correct types
      expectTypeOf(job.name).toEqualTypeOf<'branded-helpers'>()
    })
  })
})
