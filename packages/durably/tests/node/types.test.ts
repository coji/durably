/**
 * Type inference tests for core API
 *
 * Verify that types are correctly inferred from job definitions,
 * including Zod branded types.
 */

import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  defineJob,
  type Durably,
  type JobHandle,
  type Run,
  type RunFilter,
  type TriggerOptions,
} from '../../src'

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

  describe('type-safe labels', () => {
    type Labels = { organizationId: string; env: string }

    it('TriggerOptions accepts typed labels', () => {
      expectTypeOf<TriggerOptions<Labels>>().toMatchTypeOf<{
        labels?: Labels
      }>()
    })

    it('Run has typed labels', () => {
      expectTypeOf<Run<Labels>>().toMatchTypeOf<{
        labels: Labels
      }>()
    })

    it('RunFilter accepts partial labels', () => {
      expectTypeOf<RunFilter<Labels>>().toMatchTypeOf<{
        labels?: { organizationId?: string; env?: string }
      }>()
    })

    it('Durably.getRun returns Run with typed labels', () => {
      type D = Durably<Record<string, never>, Labels>
      expectTypeOf<
        D['getRun']
      >().returns.resolves.toMatchTypeOf<Run<Labels> | null>()
    })

    it('Durably.getRuns accepts RunFilter with typed labels', () => {
      type D = Durably<Record<string, never>, Labels>
      expectTypeOf<D['getRuns']>()
        .parameter(0)
        .toMatchTypeOf<RunFilter<Labels> | undefined>()
    })

    it('defaults to Record<string, string> without labels schema', () => {
      expectTypeOf<Run>().toMatchTypeOf<Run<Record<string, string>>>()
      expectTypeOf<RunFilter>().toMatchTypeOf<
        RunFilter<Record<string, string>>
      >()
    })

    it('JobHandle trigger accepts typed labels', () => {
      type Handle = JobHandle<'test', { id: string }, void, Labels>
      expectTypeOf<Handle['trigger']>()
        .parameter(1)
        .toMatchTypeOf<TriggerOptions<Labels> | undefined>()
    })

    it('createDurably infers labels type from schema', () => {
      const labelsSchema = z.object({
        organizationId: z.string(),
        env: z.string(),
      })

      // When labels schema is provided, the return type should have Labels
      const fn = (opts: { dialect: never; labels: typeof labelsSchema }) =>
        createDurably(opts)
      expectTypeOf(fn).returns.toMatchTypeOf<
        Durably<Record<string, never>, Labels>
      >()
    })
  })
})
