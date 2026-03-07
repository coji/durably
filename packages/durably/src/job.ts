import { type z, prettifyError } from 'zod'
import type { JobDefinition } from './define-job'
import type { EventEmitter, LogData, ProgressData } from './events'
import type { Run, RunFilter, Storage } from './storage'

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {}

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
   * AbortSignal for cooperative cancellation or lease-loss handling.
   */
  readonly signal: AbortSignal

  /**
   * Whether this execution should stop cooperatively.
   */
  isAborted(): boolean

  /**
   * Throw if execution has been cancelled or lease ownership was lost.
   */
  throwIfAborted(): void

  /**
   * Execute a step with automatic persistence and replay
   */
  run<T>(name: string, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T>

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
  input: TInput,
) => Promise<TOutput>

/**
 * Trigger options for trigger() and batchTrigger()
 */
export interface TriggerOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
}

/**
 * Options for triggerAndWait() (extends TriggerOptions with wait-specific options)
 */
export interface TriggerAndWaitOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> extends TriggerOptions<TLabels> {
  /** Timeout in milliseconds */
  timeout?: number
  /** Called when step.progress() is invoked during execution */
  onProgress?: (progress: ProgressData) => void | Promise<void>
  /** Called when step.log is invoked during execution */
  onLog?: (log: LogData) => void | Promise<void>
}

/**
 * Typed run with output type
 */
export interface TypedRun<
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> extends Omit<Run<TLabels>, 'output'> {
  output: TOutput | null
}

/**
 * Batch trigger input - either just the input or input with options
 */
export type BatchTriggerInput<
  TInput,
  TLabels extends Record<string, string> = Record<string, string>,
> = TInput | { input: TInput; options?: TriggerOptions<TLabels> }

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
export interface JobHandle<
  TName extends string,
  TInput,
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  readonly name: TName

  /**
   * Trigger a new run
   */
  trigger(
    input: TInput,
    options?: TriggerOptions<TLabels>,
  ): Promise<TypedRun<TOutput, TLabels>>

  /**
   * Trigger a new run and wait for completion
   * Returns the output directly, throws if the run fails
   */
  triggerAndWait(
    input: TInput,
    options?: TriggerAndWaitOptions<TLabels>,
  ): Promise<TriggerAndWaitResult<TOutput>>

  /**
   * Trigger multiple runs in a batch
   * All inputs are validated before any runs are created
   */
  batchTrigger(
    inputs: BatchTriggerInput<TInput, TLabels>[],
  ): Promise<TypedRun<TOutput, TLabels>[]>

  /**
   * Get a run by ID
   */
  getRun(id: string): Promise<TypedRun<TOutput, TLabels> | null>

  /**
   * Get runs with optional filter
   */
  getRuns(
    filter?: Omit<RunFilter<TLabels>, 'jobName'>,
  ): Promise<TypedRun<TOutput, TLabels>[]>
}

/**
 * Internal job registration
 */
export interface RegisteredJob<TInput, TOutput> {
  name: string
  inputSchema: z.ZodType
  outputSchema: z.ZodType | undefined
  labelsSchema: z.ZodType | undefined
  fn: JobFunction<TInput, TOutput>
  jobDef: JobDefinition<string, TInput, TOutput>
  // biome-ignore lint/suspicious/noExplicitAny: handle may have any labels type
  handle: JobHandle<string, TInput, TOutput, any>
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
export function createJobHandle<
  TName extends string,
  TInput,
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
>(
  jobDef: JobDefinition<TName, TInput, TOutput>,
  storage: Storage,
  eventEmitter: EventEmitter,
  registry: JobRegistry,
  labelsSchema?: z.ZodType<TLabels>,
): JobHandle<TName, TInput, TOutput, TLabels> {
  // Check if same JobDefinition is already registered (idempotent)
  const existingJob = registry.get(jobDef.name)
  if (existingJob) {
    // If same JobDefinition (same reference), return existing handle
    if (existingJob.jobDef === jobDef) {
      return existingJob.handle as JobHandle<TName, TInput, TOutput, TLabels>
    }
    // Different JobDefinition with same name - error
    throw new Error(
      `Job "${jobDef.name}" is already registered with a different definition`,
    )
  }

  const inputSchema = jobDef.input as z.ZodType<TInput>
  const outputSchema = jobDef.output as z.ZodType<TOutput> | undefined

  const handle: JobHandle<TName, TInput, TOutput, TLabels> = {
    name: jobDef.name,

    async trigger(
      input: TInput,
      options?: TriggerOptions<TLabels>,
    ): Promise<TypedRun<TOutput, TLabels>> {
      // Validate input
      const validatedInput = validateJobInputOrThrow(inputSchema, input)

      // Validate labels if schema provided
      if (labelsSchema && options?.labels) {
        validateJobInputOrThrow(labelsSchema, options.labels, 'labels')
      }

      // Create the run
      const run = await storage.queue.enqueue({
        jobName: jobDef.name,
        input: validatedInput,
        idempotencyKey: options?.idempotencyKey,
        concurrencyKey: options?.concurrencyKey,
        labels: options?.labels,
      })

      // Emit run:trigger event
      eventEmitter.emit({
        type: 'run:trigger',
        runId: run.id,
        jobName: jobDef.name,
        input: validatedInput,
        labels: run.labels,
      })

      return run as TypedRun<TOutput, TLabels>
    },

    async triggerAndWait(
      input: TInput,
      options?: TriggerAndWaitOptions<TLabels>,
    ): Promise<TriggerAndWaitResult<TOutput>> {
      // Trigger the run
      const run = await this.trigger(input, options)

      // Wait for completion via event subscription
      return new Promise((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        let resolved = false

        const unsubscribes: (() => void)[] = []

        const cleanup = () => {
          if (resolved) return
          resolved = true
          for (const unsub of unsubscribes) unsub()
          if (timeoutId) {
            clearTimeout(timeoutId)
          }
        }

        unsubscribes.push(
          eventEmitter.on('run:complete', (event) => {
            if (event.runId === run.id && !resolved) {
              cleanup()
              resolve({
                id: run.id,
                output: event.output as TOutput,
              })
            }
          }),
        )

        unsubscribes.push(
          eventEmitter.on('run:fail', (event) => {
            if (event.runId === run.id && !resolved) {
              cleanup()
              reject(new Error(event.error))
            }
          }),
        )

        if (options?.onProgress) {
          const onProgress = options.onProgress
          unsubscribes.push(
            eventEmitter.on('run:progress', (event) => {
              if (event.runId === run.id && !resolved) {
                void Promise.resolve(onProgress(event.progress)).catch(noop)
              }
            }),
          )
        }

        if (options?.onLog) {
          const onLog = options.onLog
          unsubscribes.push(
            eventEmitter.on('log:write', (event) => {
              if (event.runId === run.id && !resolved) {
                const { level, message, data, stepName } = event
                void Promise.resolve(
                  onLog({ level, message, data, stepName }),
                ).catch(noop)
              }
            }),
          )
        }

        // Check current status after subscribing (race condition mitigation)
        // If the run completed before we subscribed, we need to handle it
        storage.queue
          .getRun(run.id)
          .then((currentRun) => {
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
          .catch((error) => {
            if (resolved) return
            cleanup()
            reject(error instanceof Error ? error : new Error(String(error)))
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
      inputs: (TInput | { input: TInput; options?: TriggerOptions<TLabels> })[],
    ): Promise<TypedRun<TOutput, TLabels>[]> {
      if (inputs.length === 0) {
        return []
      }

      // Normalize inputs to { input, options } format
      const normalized = inputs.map((item) => {
        if (item && typeof item === 'object' && 'input' in item) {
          return item as { input: TInput; options?: TriggerOptions<TLabels> }
        }
        return { input: item as TInput, options: undefined }
      })

      // Validate all inputs and labels first (before creating any runs)
      const validated: {
        input: unknown
        options?: TriggerOptions<TLabels>
      }[] = []
      for (let i = 0; i < normalized.length; i++) {
        const validatedInput = validateJobInputOrThrow(
          inputSchema,
          normalized[i].input,
          `at index ${i}`,
        )
        if (labelsSchema && normalized[i].options?.labels) {
          validateJobInputOrThrow(
            labelsSchema,
            normalized[i].options?.labels,
            `labels at index ${i}`,
          )
        }
        validated.push({
          input: validatedInput,
          options: normalized[i].options,
        })
      }

      // Create all runs
      const runs = await storage.queue.enqueueMany(
        validated.map((v) => ({
          jobName: jobDef.name,
          input: v.input,
          idempotencyKey: v.options?.idempotencyKey,
          concurrencyKey: v.options?.concurrencyKey,
          labels: v.options?.labels,
        })),
      )

      // Emit run:trigger events for all created runs
      for (let i = 0; i < runs.length; i++) {
        eventEmitter.emit({
          type: 'run:trigger',
          runId: runs[i].id,
          jobName: jobDef.name,
          input: validated[i].input,
          labels: runs[i].labels,
        })
      }

      return runs as TypedRun<TOutput, TLabels>[]
    },

    async getRun(id: string): Promise<TypedRun<TOutput, TLabels> | null> {
      const run = await storage.queue.getRun(id)
      if (!run || run.jobName !== jobDef.name) {
        return null
      }
      return run as TypedRun<TOutput, TLabels>
    },

    async getRuns(
      filter?: Omit<RunFilter<TLabels>, 'jobName'>,
    ): Promise<TypedRun<TOutput, TLabels>[]> {
      const runs = await storage.queue.getRuns({
        ...filter,
        jobName: jobDef.name,
      })
      return runs as TypedRun<TOutput, TLabels>[]
    },
  }

  // Register the job with the handle
  registry.set({
    name: jobDef.name,
    inputSchema,
    outputSchema,
    labelsSchema,
    fn: jobDef.run as JobFunction<unknown, unknown>,
    jobDef: jobDef as JobDefinition<string, TInput, TOutput>,
    handle,
  })

  return handle
}
