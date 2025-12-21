import type { z } from 'zod'
import type { EventEmitter } from './events'
import type { Run, Storage } from './storage'

/**
 * Job context passed to the job function
 */
export interface JobContext {
  /**
   * The ID of the current run
   */
  readonly runId: string

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
  context: JobContext,
  payload: TInput,
) => Promise<TOutput>

/**
 * Job definition options
 */
export interface JobDefinition<
  TName extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType | undefined,
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
  /** Timeout in milliseconds for triggerAndWait() */
  timeout?: number
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
 * Batch trigger input - either just the input or input with options
 */
export type BatchTriggerInput<TInput> =
  | TInput
  | { input: TInput; options?: TriggerOptions }

/**
 * Result of triggerAndWait
 */
export interface TriggerAndWaitResult<TOutput> {
  id: string
  output: TOutput
}

/**
 * Job handle returned by defineJob
 */
export interface JobHandle<TName extends string, TInput, TOutput> {
  readonly name: TName

  /**
   * Trigger a new run
   */
  trigger(input: TInput, options?: TriggerOptions): Promise<TypedRun<TOutput>>

  /**
   * Trigger a new run and wait for completion
   * Returns the output directly, throws if the run fails
   */
  triggerAndWait(
    input: TInput,
    options?: TriggerOptions,
  ): Promise<TriggerAndWaitResult<TOutput>>

  /**
   * Trigger multiple runs in a batch
   * All inputs are validated before any runs are created
   */
  batchTrigger(
    inputs: BatchTriggerInput<TInput>[],
  ): Promise<TypedRun<TOutput>[]>

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
  inputSchema: z.ZodType
  outputSchema: z.ZodType | undefined
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
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType | undefined,
>(
  definition: JobDefinition<TName, TInputSchema, TOutputSchema>,
  fn: JobFunction<
    z.infer<TInputSchema>,
    TOutputSchema extends z.ZodType ? z.infer<TOutputSchema> : void
  >,
  storage: Storage,
  _eventEmitter: EventEmitter,
  registry: JobRegistry,
): JobHandle<
  TName,
  z.infer<TInputSchema>,
  TOutputSchema extends z.ZodType ? z.infer<TOutputSchema> : undefined
> {
  type TInput = z.infer<TInputSchema>
  type TOutput = TOutputSchema extends z.ZodType
    ? z.infer<TOutputSchema>
    : undefined

  // Register the job
  registry.register({
    name: definition.name,
    inputSchema: definition.input,
    outputSchema: definition.output,
    fn: fn as JobFunction<unknown, unknown>,
  })

  return {
    name: definition.name,

    async trigger(
      input: TInput,
      options?: TriggerOptions,
    ): Promise<TypedRun<TOutput>> {
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

    async triggerAndWait(
      input: TInput,
      options?: TriggerOptions,
    ): Promise<TriggerAndWaitResult<TOutput>> {
      // Trigger the run
      const run = await this.trigger(input, options)

      // Wait for completion via event subscription
      return new Promise((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        let resolved = false

        const cleanup = () => {
          if (resolved) return
          resolved = true
          unsubscribeComplete()
          unsubscribeFail()
          if (timeoutId) {
            clearTimeout(timeoutId)
          }
        }

        const unsubscribeComplete = _eventEmitter.on(
          'run:complete',
          (event) => {
            if (event.runId === run.id && !resolved) {
              cleanup()
              resolve({
                id: run.id,
                output: event.output as TOutput,
              })
            }
          },
        )

        const unsubscribeFail = _eventEmitter.on('run:fail', (event) => {
          if (event.runId === run.id && !resolved) {
            cleanup()
            reject(new Error(event.error))
          }
        })

        // Check current status after subscribing (race condition mitigation)
        // If the run completed before we subscribed, we need to handle it
        storage.getRun(run.id).then((currentRun) => {
          if (resolved || !currentRun) return
          if (currentRun.status === 'completed') {
            cleanup()
            resolve({
              id: run.id,
              output: currentRun.output as TOutput,
            })
          } else if (currentRun.status === 'failed') {
            cleanup()
            reject(new Error(currentRun.error || 'Run failed'))
          }
        })

        // Set timeout if specified
        if (options?.timeout !== undefined) {
          timeoutId = setTimeout(() => {
            if (!resolved) {
              cleanup()
              reject(
                new Error(`triggerAndWait timeout after ${options.timeout}ms`),
              )
            }
          }, options.timeout)
        }
      })
    },

    async batchTrigger(
      inputs: (TInput | { input: TInput; options?: TriggerOptions })[],
    ): Promise<TypedRun<TOutput>[]> {
      if (inputs.length === 0) {
        return []
      }

      // Normalize inputs to { input, options } format
      const normalized = inputs.map((item) => {
        if (item && typeof item === 'object' && 'input' in item) {
          return item as { input: TInput; options?: TriggerOptions }
        }
        return { input: item as TInput, options: undefined }
      })

      // Validate all inputs first (before creating any runs)
      const validated: { payload: unknown; options?: TriggerOptions }[] = []
      for (let i = 0; i < normalized.length; i++) {
        const parseResult = definition.input.safeParse(normalized[i].input)
        if (!parseResult.success) {
          throw new Error(
            `Invalid input at index ${i}: ${parseResult.error.message}`,
          )
        }
        validated.push({
          payload: parseResult.data,
          options: normalized[i].options,
        })
      }

      // Create all runs
      const runs = await storage.batchCreateRuns(
        validated.map((v) => ({
          jobName: definition.name,
          payload: v.payload,
          idempotencyKey: v.options?.idempotencyKey,
          concurrencyKey: v.options?.concurrencyKey,
        })),
      )

      return runs as TypedRun<TOutput>[]
    },

    async getRun(id: string): Promise<TypedRun<TOutput> | null> {
      const run = await storage.getRun(id)
      if (!run || run.jobName !== definition.name) {
        return null
      }
      return run as TypedRun<TOutput>
    },

    async getRuns(
      filter?: Omit<RunFilter, 'jobName'>,
    ): Promise<TypedRun<TOutput>[]> {
      const runs = await storage.getRuns({
        ...filter,
        jobName: definition.name,
      })
      return runs as TypedRun<TOutput>[]
    },
  }
}
