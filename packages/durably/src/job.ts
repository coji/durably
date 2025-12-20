import type { z } from 'zod'
import type { EventEmitter } from './events'
import type { Run, Storage } from './storage'

/**
 * Job context passed to the job function
 */
export interface JobContext {
  /**
   * Execute a step with automatic persistence and replay
   */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>

  /**
   * Report progress for the current run
   */
  progress(current: number, total?: number, message?: string): void

  /**
   * Log a message
   */
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

/**
 * Job function type
 */
export type JobFunction<TInput, TOutput> = (
  ctx: JobContext,
  payload: TInput
) => Promise<TOutput>

/**
 * Job definition options
 */
export interface JobDefinition<
  TName extends string,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny | undefined,
> {
  name: TName
  input: TInputSchema
  output?: TOutputSchema
}

/**
 * Trigger options
 */
export interface TriggerOptions {
  idempotencyKey?: string
  concurrencyKey?: string
}

/**
 * Run filter options
 */
export interface RunFilter {
  status?: 'pending' | 'running' | 'completed' | 'failed'
  jobName?: string
}

/**
 * Typed run with output type
 */
export interface TypedRun<TOutput> extends Omit<Run, 'output'> {
  output: TOutput | null
}

/**
 * Job handle returned by defineJob
 */
export interface JobHandle<
  TName extends string,
  TInput,
  TOutput,
> {
  readonly name: TName

  /**
   * Trigger a new run
   */
  trigger(input: TInput, options?: TriggerOptions): Promise<TypedRun<TOutput>>

  /**
   * Get a run by ID
   */
  getRun(id: string): Promise<TypedRun<TOutput> | null>

  /**
   * Get runs with optional filter
   */
  getRuns(filter?: Omit<RunFilter, 'jobName'>): Promise<TypedRun<TOutput>[]>
}

/**
 * Internal job registration
 */
export interface RegisteredJob<TInput, TOutput> {
  name: string
  inputSchema: z.ZodTypeAny
  outputSchema: z.ZodTypeAny | undefined
  fn: JobFunction<TInput, TOutput>
}

/**
 * Job registry for managing registered jobs
 */
export interface JobRegistry {
  /**
   * Register a job
   */
  register<TInput, TOutput>(job: RegisteredJob<TInput, TOutput>): void

  /**
   * Get a registered job by name
   */
  get(name: string): RegisteredJob<unknown, unknown> | undefined

  /**
   * Check if a job is registered
   */
  has(name: string): boolean
}

/**
 * Create a job registry
 */
export function createJobRegistry(): JobRegistry {
  const jobs = new Map<string, RegisteredJob<unknown, unknown>>()

  return {
    register<TInput, TOutput>(job: RegisteredJob<TInput, TOutput>): void {
      if (jobs.has(job.name)) {
        throw new Error(`Job "${job.name}" is already registered`)
      }
      jobs.set(job.name, job as RegisteredJob<unknown, unknown>)
    },

    get(name: string): RegisteredJob<unknown, unknown> | undefined {
      return jobs.get(name)
    },

    has(name: string): boolean {
      return jobs.has(name)
    },
  }
}

/**
 * Create a job handle
 */
export function createJobHandle<
  TName extends string,
  TInputSchema extends z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny | undefined,
>(
  definition: JobDefinition<TName, TInputSchema, TOutputSchema>,
  fn: JobFunction<z.infer<TInputSchema>, TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void>,
  storage: Storage,
  _eventEmitter: EventEmitter,
  registry: JobRegistry
): JobHandle<
  TName,
  z.infer<TInputSchema>,
  TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void
> {
  type TInput = z.infer<TInputSchema>
  type TOutput = TOutputSchema extends z.ZodTypeAny ? z.infer<TOutputSchema> : void

  // Register the job
  registry.register({
    name: definition.name,
    inputSchema: definition.input,
    outputSchema: definition.output,
    fn: fn as JobFunction<unknown, unknown>,
  })

  return {
    name: definition.name,

    async trigger(input: TInput, options?: TriggerOptions): Promise<TypedRun<TOutput>> {
      // Validate input
      const parseResult = definition.input.safeParse(input)
      if (!parseResult.success) {
        throw new Error(`Invalid input: ${parseResult.error.message}`)
      }

      // Create the run
      const run = await storage.createRun({
        jobName: definition.name,
        payload: parseResult.data,
        idempotencyKey: options?.idempotencyKey,
        concurrencyKey: options?.concurrencyKey,
      })

      return run as TypedRun<TOutput>
    },

    async getRun(id: string): Promise<TypedRun<TOutput> | null> {
      const run = await storage.getRun(id)
      if (!run || run.jobName !== definition.name) {
        return null
      }
      return run as TypedRun<TOutput>
    },

    async getRuns(filter?: Omit<RunFilter, 'jobName'>): Promise<TypedRun<TOutput>[]> {
      const runs = await storage.getRuns({
        ...filter,
        jobName: definition.name,
      })
      return runs as TypedRun<TOutput>[]
    },
  }
}
