import { type z, prettifyError } from 'zod'
import type { JobDefinition } from './define-job'
import {
  CancelledError,
  NotFoundError,
  toError,
  ValidationError,
} from './errors'
import type { EventEmitter, LogData, ProgressData } from './events'
import type { Run, RunFilter, Store } from './storage'

/** Matches `createDurably` default when callers omit `pollingIntervalMs` on the wait options. */
const DEFAULT_WAIT_POLLING_INTERVAL_MS = 1000

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {}

/**
 * Validate job input and throw on failure
 */
export function validateJobInputOrThrow<T>(
  schema: z.ZodType<T>,
  input: unknown,
  context?: string,
): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    const prefix = context ? `${context}: ` : ''
    throw new ValidationError(
      `${prefix}Invalid input: ${prettifyError(result.error)}`,
    )
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
 * How a trigger was resolved relative to durable storage.
 */
export type Disposition = 'created' | 'idempotent' | 'coalesced'

/**
 * Trigger options for trigger() and batchTrigger()
 */
export interface TriggerOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: 'skip'
}

/**
 * Options for waiting on a run (live onProgress/onLog only; no replay of past events)
 */
export interface WaitForRunOptions {
  /** Timeout in milliseconds */
  timeout?: number
  /**
   * Storage polling interval when waiting for a non-terminal run (cross-runtime fallback).
   * Omitted values inherit the surrounding `createDurably({ pollingIntervalMs })` setting.
   */
  pollingIntervalMs?: number
  /** Called when step.progress() is invoked during execution */
  onProgress?: (progress: ProgressData) => void | Promise<void>
  /** Called when step.log is invoked during execution */
  onLog?: (log: LogData) => void | Promise<void>
}

/**
 * Options for triggerAndWait() (extends TriggerOptions with wait-specific options)
 */
export interface TriggerAndWaitOptions<
  TLabels extends Record<string, string> = Record<string, string>,
>
  extends TriggerOptions<TLabels>, WaitForRunOptions {}

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
 * Result of trigger() / batchTrigger(): the run plus how it was resolved.
 */
export type TriggerResult<
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> = TypedRun<TOutput, TLabels> & { disposition: Disposition }

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
  disposition: Disposition
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
  ): Promise<TriggerResult<TOutput, TLabels>>

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
  ): Promise<TriggerResult<TOutput, TLabels>[]>

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
 * Wait for a run to reach a terminal state via events and storage (race-safe).
 * Subscribes to run:complete, run:fail, run:cancel; onProgress/onLog only when the run is still active.
 */
export function waitForRunCompletion(
  runId: string,
  storage: Store,
  eventEmitter: EventEmitter,
  options?: WaitForRunOptions,
  timeoutMessagePrefix = 'waitForRun',
): Promise<Run> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let pollIntervalId: ReturnType<typeof setInterval> | undefined
    let resolved = false
    let pollInFlight = false

    const unsubscribes: (() => void)[] = []

    const pollingMs =
      options?.pollingIntervalMs ?? DEFAULT_WAIT_POLLING_INTERVAL_MS
    if (!Number.isFinite(pollingMs) || pollingMs <= 0) {
      throw new ValidationError(
        'pollingIntervalMs must be a positive finite number',
      )
    }

    const cleanup = () => {
      if (resolved) return
      resolved = true
      for (const unsub of unsubscribes) unsub()
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      if (pollIntervalId !== undefined) {
        clearInterval(pollIntervalId)
        pollIntervalId = undefined
      }
    }

    const settleFromStorage = (run: Run | null) => {
      if (resolved) return
      if (!run) {
        cleanup()
        reject(new NotFoundError(`Run not found: ${runId}`))
        return
      }
      if (run.status === 'completed') {
        cleanup()
        resolve(run)
        return
      }
      if (run.status === 'failed') {
        cleanup()
        reject(new Error(run.error || 'Run failed'))
        return
      }
      if (run.status === 'cancelled') {
        cleanup()
        reject(new CancelledError(runId))
        return
      }
    }

    const poll = () => {
      if (resolved || pollInFlight) return
      pollInFlight = true
      void storage
        .getRun(runId)
        .then((run) => {
          if (resolved) return
          settleFromStorage(run)
        })
        .catch((err) => {
          if (resolved) return
          cleanup()
          reject(toError(err))
        })
        .finally(() => {
          pollInFlight = false
        })
    }

    unsubscribes.push(
      eventEmitter.on('run:complete', (event) => {
        if (event.runId !== runId || resolved) return
        cleanup()
        storage
          .getRun(runId)
          .then((run) => {
            if (run) resolve(run)
            else reject(new NotFoundError(`Run not found: ${runId}`))
          })
          .catch((err) => reject(toError(err)))
      }),
    )

    unsubscribes.push(
      eventEmitter.on('run:fail', (event) => {
        if (event.runId !== runId || resolved) return
        cleanup()
        reject(new Error(event.error))
      }),
    )

    unsubscribes.push(
      eventEmitter.on('run:cancel', (event) => {
        if (event.runId !== runId || resolved) return
        cleanup()
        reject(new CancelledError(runId))
      }),
    )

    if (options?.onProgress) {
      const onProgress = options.onProgress
      unsubscribes.push(
        eventEmitter.on('run:progress', (event) => {
          if (event.runId !== runId || resolved) return
          void Promise.resolve(onProgress(event.progress)).catch(noop)
        }),
      )
    }

    if (options?.onLog) {
      const onLog = options.onLog
      unsubscribes.push(
        eventEmitter.on('log:write', (event) => {
          if (event.runId !== runId || resolved) return
          const { level, message, data, stepName } = event
          void Promise.resolve(onLog({ level, message, data, stepName })).catch(
            noop,
          )
        }),
      )
    }

    storage
      .getRun(runId)
      .then((currentRun) => {
        if (resolved) return
        if (!currentRun) {
          cleanup()
          reject(new NotFoundError(`Run not found: ${runId}`))
          return
        }
        if (currentRun.status === 'completed') {
          cleanup()
          resolve(currentRun)
          return
        }
        if (currentRun.status === 'failed') {
          cleanup()
          reject(new Error(currentRun.error || 'Run failed'))
          return
        }
        if (currentRun.status === 'cancelled') {
          cleanup()
          reject(new CancelledError(runId))
          return
        }
        pollIntervalId = setInterval(poll, pollingMs)
      })
      .catch((error) => {
        if (resolved) return
        cleanup()
        reject(toError(error))
      })

    if (options?.timeout !== undefined) {
      timeoutId = setTimeout(() => {
        if (!resolved) {
          cleanup()
          reject(
            new Error(
              `${timeoutMessagePrefix} timeout after ${options.timeout}ms`,
            ),
          )
        }
      }, options.timeout)
    }
  })
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
  storage: Store,
  eventEmitter: EventEmitter,
  registry: JobRegistry,
  labelsSchema: z.ZodType<TLabels> | undefined,
  pollingIntervalMs: number,
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

  function validateCoalesceOption(
    coalesce: string | undefined,
    concurrencyKey: string | undefined,
    context?: string,
  ) {
    if (coalesce === undefined) return
    const suffix = context ? ` ${context}` : ''
    if (coalesce !== 'skip') {
      throw new ValidationError(
        `Invalid coalesce value${suffix}: '${coalesce}'. Valid values: 'skip'`,
      )
    }
    if (!concurrencyKey) {
      throw new ValidationError(`coalesce requires concurrencyKey${suffix}`)
    }
  }

  function emitDispositionEvent(
    disposition: Disposition,
    run: Run,
    input: unknown,
    labels?: Record<string, string>,
  ) {
    if (disposition === 'created') {
      eventEmitter.emit({
        type: 'run:trigger',
        runId: run.id,
        jobName: jobDef.name,
        input,
        labels: run.labels,
      })
    } else if (disposition === 'coalesced') {
      eventEmitter.emit({
        type: 'run:coalesced',
        runId: run.id,
        jobName: jobDef.name,
        labels: run.labels,
        skippedInput: input,
        skippedLabels: labels ?? {},
      })
    }
    // 'idempotent': intentionally no event — the run already exists unchanged
  }

  const handle: JobHandle<TName, TInput, TOutput, TLabels> = {
    name: jobDef.name,

    async trigger(
      input: TInput,
      options?: TriggerOptions<TLabels>,
    ): Promise<TriggerResult<TOutput, TLabels>> {
      validateCoalesceOption(options?.coalesce, options?.concurrencyKey)

      // Validate input
      const validatedInput = validateJobInputOrThrow(inputSchema, input)

      // Validate labels if schema provided (use parsed result for strip/default/coerce)
      const validatedLabels =
        labelsSchema && options?.labels
          ? validateJobInputOrThrow(labelsSchema, options.labels, 'labels')
          : options?.labels

      // Create the run
      const { run, disposition } = await storage.enqueue({
        jobName: jobDef.name,
        input: validatedInput,
        idempotencyKey: options?.idempotencyKey,
        concurrencyKey: options?.concurrencyKey,
        labels: validatedLabels,
        coalesce: options?.coalesce,
      })

      emitDispositionEvent(
        disposition,
        run,
        validatedInput,
        validatedLabels as Record<string, string>,
      )

      return { ...run, disposition } as TriggerResult<TOutput, TLabels>
    },

    async triggerAndWait(
      input: TInput,
      options?: TriggerAndWaitOptions<TLabels>,
    ): Promise<TriggerAndWaitResult<TOutput>> {
      const run = await this.trigger(input, options)

      const completedRun = await waitForRunCompletion(
        run.id,
        storage,
        eventEmitter,
        {
          ...options,
          pollingIntervalMs: options?.pollingIntervalMs ?? pollingIntervalMs,
        },
        'triggerAndWait',
      )

      return {
        id: run.id,
        output: completedRun.output as TOutput,
        disposition: run.disposition,
      }
    },

    async batchTrigger(
      inputs: (TInput | { input: TInput; options?: TriggerOptions<TLabels> })[],
    ): Promise<TriggerResult<TOutput, TLabels>[]> {
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

      // Validate all inputs, labels, and coalesce options first
      const validated: {
        input: unknown
        options?: TriggerOptions<TLabels>
      }[] = []
      for (let i = 0; i < normalized.length; i++) {
        const opts = normalized[i].options
        validateCoalesceOption(
          opts?.coalesce,
          opts?.concurrencyKey,
          `at index ${i}`,
        )
        const validatedInput = validateJobInputOrThrow(
          inputSchema,
          normalized[i].input,
          `at index ${i}`,
        )
        const validatedLabels =
          labelsSchema && opts?.labels
            ? validateJobInputOrThrow(
                labelsSchema,
                opts.labels,
                `labels at index ${i}`,
              )
            : opts?.labels
        validated.push({
          input: validatedInput,
          options: opts ? { ...opts, labels: validatedLabels } : opts,
        })
      }

      // Create all runs (sequential enqueue with per-item conflict handling)
      const results = await storage.enqueueMany(
        validated.map((v) => ({
          jobName: jobDef.name,
          input: v.input,
          idempotencyKey: v.options?.idempotencyKey,
          concurrencyKey: v.options?.concurrencyKey,
          labels: v.options?.labels,
          coalesce: v.options?.coalesce,
        })),
      )

      // Emit events based on disposition
      for (let i = 0; i < results.length; i++) {
        emitDispositionEvent(
          results[i].disposition,
          results[i].run,
          validated[i].input,
          validated[i].options?.labels as Record<string, string>,
        )
      }

      return results.map(
        (r) =>
          ({
            ...r.run,
            disposition: r.disposition,
          }) as TriggerResult<TOutput, TLabels>,
      )
    },

    async getRun(id: string): Promise<TypedRun<TOutput, TLabels> | null> {
      const run = await storage.getRun(id)
      if (!run || run.jobName !== jobDef.name) {
        return null
      }
      return run as TypedRun<TOutput, TLabels>
    },

    async getRuns(
      filter?: Omit<RunFilter<TLabels>, 'jobName'>,
    ): Promise<TypedRun<TOutput, TLabels>[]> {
      const runs = await storage.getRuns({
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
