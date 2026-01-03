import { type z, prettifyError } from 'zod'
import type { JobDefinition } from './define-job'
import type { EventEmitter } from './events'
import type { Run, Storage } from './storage'

/**
 * Validate job input and throw on failure
 */
function validateJobInputOrThrow<T>(
  schema: z.ZodType<T>,
  input: unknown,
  context?: string,
): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const prefix = context ? `${context}: ` : ''
    throw new Error(`${prefix}Invalid input: ${prettifyError(result.error)}`)
  }
  return result.data
}

/**
 * Step context passed to the job function
 */
export interface StepContext {
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
  step: StepContext,
  payload: TInput,
) => Promise<TOutput>

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
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  jobName?: string
  /** Maximum number of runs to return */
  limit?: number
  /** Number of runs to skip (for pagination) */
  offset?: number
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
  jobDef: JobDefinition<string, TInput, TOutput>
  handle: JobHandle<string, TInput, TOutput>
}

/**
 * Job registry for managing registered jobs
 */
export interface JobRegistry {
  /**
   * Register a job (called internally by createJobHandle)
   */
  set<TInput, TOutput>(job: RegisteredJob<TInput, TOutput>): void

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
    set<TInput, TOutput>(job: RegisteredJob<TInput, TOutput>): void {
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
 * Create a job handle from a JobDefinition
 */
export function createJobHandle<TName extends string, TInput, TOutput>(
  jobDef: JobDefinition<TName, TInput, TOutput>,
  storage: Storage,
  eventEmitter: EventEmitter,
  registry: JobRegistry,
): JobHandle<TName, TInput, TOutput> {
  // Check if same JobDefinition is already registered (idempotent)
  const existingJob = registry.get(jobDef.name)
  if (existingJob) {
    // If same JobDefinition (same reference), return existing handle
    if (existingJob.jobDef === jobDef) {
      return existingJob.handle as JobHandle<TName, TInput, TOutput>
    }
    // Different JobDefinition with same name - error
    throw new Error(
      `Job "${jobDef.name}" is already registered with a different definition`,
    )
  }

  const inputSchema = jobDef.input as z.ZodType<TInput>
  const outputSchema = jobDef.output as z.ZodType<TOutput> | undefined

  const handle: JobHandle<TName, TInput, TOutput> = {
    name: jobDef.name,

    async trigger(
      input: TInput,
      options?: TriggerOptions,
    ): Promise<TypedRun<TOutput>> {
      // Validate input
      const validatedInput = validateJobInputOrThrow(inputSchema, input)

      // Create the run
      const run = await storage.createRun({
        jobName: jobDef.name,
        payload: validatedInput,
        idempotencyKey: options?.idempotencyKey,
        concurrencyKey: options?.concurrencyKey,
      })

      // Emit run:trigger event
      eventEmitter.emit({
        type: 'run:trigger',
        runId: run.id,
        jobName: jobDef.name,
        payload: validatedInput,
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

        const unsubscribeComplete = eventEmitter.on('run:complete', (event) => {
          if (event.runId === run.id && !resolved) {
            cleanup()
            resolve({
              id: run.id,
              output: event.output as TOutput,
            })
          }
        })

        const unsubscribeFail = eventEmitter.on('run:fail', (event) => {
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
        const validatedInput = validateJobInputOrThrow(
          inputSchema,
          normalized[i].input,
          `at index ${i}`,
        )
        validated.push({
          payload: validatedInput,
          options: normalized[i].options,
        })
      }

      // Create all runs
      const runs = await storage.batchCreateRuns(
        validated.map((v) => ({
          jobName: jobDef.name,
          payload: v.payload,
          idempotencyKey: v.options?.idempotencyKey,
          concurrencyKey: v.options?.concurrencyKey,
        })),
      )

      // Emit run:trigger events for all created runs
      for (let i = 0; i < runs.length; i++) {
        eventEmitter.emit({
          type: 'run:trigger',
          runId: runs[i].id,
          jobName: jobDef.name,
          payload: validated[i].payload,
        })
      }

      return runs as TypedRun<TOutput>[]
    },

    async getRun(id: string): Promise<TypedRun<TOutput> | null> {
      const run = await storage.getRun(id)
      if (!run || run.jobName !== jobDef.name) {
        return null
      }
      return run as TypedRun<TOutput>
    },

    async getRuns(
      filter?: Omit<RunFilter, 'jobName'>,
    ): Promise<TypedRun<TOutput>[]> {
      const runs = await storage.getRuns({
        ...filter,
        jobName: jobDef.name,
      })
      return runs as TypedRun<TOutput>[]
    },
  }

  // Register the job with the handle
  registry.set({
    name: jobDef.name,
    inputSchema,
    outputSchema,
    fn: jobDef.run as JobFunction<unknown, unknown>,
    jobDef: jobDef as JobDefinition<string, TInput, TOutput>,
    handle: handle as JobHandle<string, TInput, TOutput>,
  })

  return handle
}
