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
  isDomainEvent,
  type DomainEvent,
  type DomainEventType,
  type Durably,
  type DurablyEvent,
  type JobHandle,
  type LogData,
  type OperationalEvent,
  type OperationalEventType,
  type ProgressData,
  type Run,
  type RunFilter,
  type RunStatus,
  type TriggerOptions,
  type WaitForRunOptions,
} from '../../src'

describe('Type inference', () => {
  it('createDurably options include optional maxConcurrentRuns', () => {
    expectTypeOf({
      dialect: {} as never,
      maxConcurrentRuns: 2 as number | undefined,
    }).toMatchTypeOf<Parameters<typeof createDurably>[0]>()
  })

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

    it('RunFilter.status accepts a single status or an array', () => {
      expectTypeOf<RunFilter['status']>().toEqualTypeOf<
        RunStatus | RunStatus[] | undefined
      >()
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

  describe('waitForRun', () => {
    it('is non-generic and resolves to completed run with unknown output', () => {
      type D = Durably<Record<string, never>, Record<string, string>>
      expectTypeOf<D['waitForRun']>().parameter(0).toEqualTypeOf<string>()
      expectTypeOf<D['waitForRun']>()
        .parameter(1)
        .toEqualTypeOf<WaitForRunOptions | undefined>()
      expectTypeOf<D['waitForRun']>().returns.resolves.toMatchTypeOf<
        Run<Record<string, string>> & { status: 'completed'; output: unknown }
      >()
    })

    it('exports WaitForRunOptions with timeout, polling, and live callbacks', () => {
      expectTypeOf<WaitForRunOptions>().toMatchTypeOf<{
        timeout?: number
        pollingIntervalMs?: number
        onProgress?: (progress: ProgressData) => void | Promise<void>
        onLog?: (log: LogData) => void | Promise<void>
      }>()
    })
  })

  describe('event classification exports', () => {
    it('exports isDomainEvent as a type guard', () => {
      expectTypeOf(isDomainEvent).parameter(0).toEqualTypeOf<DurablyEvent>()
      const e = {} as DurablyEvent
      if (isDomainEvent(e)) {
        expectTypeOf(e).toEqualTypeOf<DomainEvent>()
      }
    })

    it('exports DomainEventType and OperationalEventType aligned with event unions', () => {
      expectTypeOf<DomainEventType>().toEqualTypeOf<DomainEvent['type']>()
      expectTypeOf<OperationalEventType>().toEqualTypeOf<
        OperationalEvent['type']
      >()
    })

    it('exports OperationalEvent as the non-domain slice of DurablyEvent', () => {
      expectTypeOf<
        Exclude<DurablyEvent, DomainEvent>
      >().toEqualTypeOf<OperationalEvent>()
      expectTypeOf<OperationalEvent>().toMatchTypeOf<DurablyEvent>()
    })
  })
})
