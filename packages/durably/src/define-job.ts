import type { z } from 'zod'
import type { StepContext } from './job'

/**
 * Job run function type
 */
export type JobRunFunction<TInput, TOutput> = (
  step: StepContext,
  payload: TInput,
) => Promise<TOutput>

/**
 * Job definition - a standalone description of a job
 * This is the result of calling defineJob() and can be passed to durably.register()
 */
export interface JobDefinition<
  TName extends string,
  TInput,
  TOutput,
> {
  readonly name: TName
  readonly input: z.ZodType<TInput>
  readonly output: z.ZodType<TOutput> | undefined
  readonly run: JobRunFunction<TInput, TOutput>
}

/**
 * Configuration for defining a job
 */
export interface DefineJobConfig<
  TName extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType | undefined,
> {
  name: TName
  input: TInputSchema
  output?: TOutputSchema
  run: JobRunFunction<
    z.infer<TInputSchema>,
    TOutputSchema extends z.ZodType ? z.infer<TOutputSchema> : void
  >
}

/**
 * Define a job - creates a JobDefinition that can be registered with durably.register()
 *
 * @example
 * ```ts
 * import { defineJob } from '@coji/durably'
 * import { z } from 'zod'
 *
 * export const syncUsers = defineJob({
 *   name: 'sync-users',
 *   input: z.object({ orgId: z.string() }),
 *   output: z.object({ syncedCount: z.number() }),
 *   run: async (step, payload) => {
 *     const users = await step.run('fetch-users', () => fetchUsers(payload.orgId))
 *     return { syncedCount: users.length }
 *   },
 * })
 * ```
 */
export function defineJob<
  TName extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType | undefined = undefined,
>(
  config: DefineJobConfig<TName, TInputSchema, TOutputSchema>,
): JobDefinition<
  TName,
  z.infer<TInputSchema>,
  TOutputSchema extends z.ZodType ? z.infer<TOutputSchema> : void
> {
  return {
    name: config.name,
    input: config.input,
    output: config.output,
    run: config.run,
  } as JobDefinition<
    TName,
    z.infer<TInputSchema>,
    TOutputSchema extends z.ZodType ? z.infer<TOutputSchema> : void
  >
}
