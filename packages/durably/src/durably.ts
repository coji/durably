import type { Dialect } from 'kysely'
import { Kysely } from 'kysely'
import { monotonicFactory } from 'ulidx'
import type { z } from 'zod'
import { createStepContext } from './context'
import type { JobDefinition } from './define-job'
import { CancelledError, getErrorMessage, LeaseLostError } from './errors'
import {
  type AnyEventInput,
  type DurablyEvent,
  type ErrorHandler,
  type EventEmitter,
  type EventListener,
  type EventType,
  type Unsubscribe,
  createEventEmitter,
} from './events'
import {
  type JobHandle,
  type JobRegistry,
  createJobHandle,
  createJobRegistry,
} from './job'
import { runMigrations } from './migrations'
import type { Database } from './schema'
import {
  type DatabaseBackend,
  type Run,
  type RunFilter,
  type Store,
  createKyselyStore,
} from './storage'
import { type Worker, createWorker } from './worker'

/**
 * Options for creating a Durably instance
 */
export interface DurablyOptions<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
> {
  dialect: Dialect
  /**
   * Browser-local singleton key used to detect multiple runtimes against the same local database in one tab.
   * When omitted, Durably will use browser-local dialect metadata if available.
   */
  singletonKey?: string
  pollingIntervalMs?: number
  leaseRenewIntervalMs?: number
  leaseMs?: number
  preserveSteps?: boolean
  /**
   * Zod schema for labels. When provided:
   * - Labels are type-checked at compile time
   * - Labels are validated at runtime on trigger()
   */
  labels?: z.ZodType<TLabels>
  /**
   * Job definitions to register. Shorthand for calling .register() after creation.
   * @example
   * ```ts
   * const durably = createDurably({
   *   dialect,
   *   jobs: { importCsv: importCsvJob, syncUsers: syncUsersJob },
   * })
   * ```
   */
  jobs?: TJobs
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  pollingIntervalMs: 1000,
  leaseRenewIntervalMs: 5000,
  leaseMs: 30000,
  preserveSteps: false,
} as const

const ulid = monotonicFactory()
const BROWSER_SINGLETON_REGISTRY_KEY = '__durablyBrowserSingletonRegistry'
const BROWSER_LOCAL_DIALECT_KEY = '__durablyBrowserLocalKey'

function defaultWorkerId(): string {
  return `worker_${ulid()}`
}

function detectBackend(dialect: Dialect): DatabaseBackend {
  return dialect.constructor.name === 'PostgresDialect' ? 'postgres' : 'generic'
}

function isBrowserLikeEnvironment(): boolean {
  return (
    typeof globalThis.window !== 'undefined' ||
    typeof globalThis.document !== 'undefined'
  )
}

function getBrowserSingletonKey(
  dialect: Dialect,
  explicitKey?: string,
): string | null {
  if (!isBrowserLikeEnvironment()) {
    return null
  }

  if (explicitKey) {
    return explicitKey
  }

  const taggedDialect = dialect as Dialect & {
    [BROWSER_LOCAL_DIALECT_KEY]?: unknown
  }
  const taggedKey = taggedDialect[BROWSER_LOCAL_DIALECT_KEY]
  return typeof taggedKey === 'string' ? taggedKey : null
}

function registerBrowserSingletonWarning(singletonKey: string): () => void {
  type Registry = Map<string, Set<string>>
  const globalRegistry = globalThis as typeof globalThis & {
    [BROWSER_SINGLETON_REGISTRY_KEY]?: Registry
  }
  const registry =
    globalRegistry[BROWSER_SINGLETON_REGISTRY_KEY] ??
    new Map<string, Set<string>>()
  globalRegistry[BROWSER_SINGLETON_REGISTRY_KEY] = registry

  const instanceId = ulid()
  const instances = registry.get(singletonKey) ?? new Set<string>()
  const hadExistingInstance = instances.size > 0
  instances.add(instanceId)
  registry.set(singletonKey, instances)

  if (
    hadExistingInstance &&
    (typeof process === 'undefined' || process.env.NODE_ENV !== 'production')
  ) {
    console.warn(
      `[durably] Multiple runtimes were created for browser-local store "${singletonKey}" in one tab. Prefer a single shared instance per tab.`,
    )
  }

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const activeInstances = registry.get(singletonKey)
    if (!activeInstances) {
      return
    }
    activeInstances.delete(instanceId)
    if (activeInstances.size === 0) {
      registry.delete(singletonKey)
    }
  }
}

/**
 * Plugin interface for extending Durably
 */
export interface DurablyPlugin {
  name: string
  // biome-ignore lint/suspicious/noExplicitAny: plugin needs to accept any Durably instance
  install(durably: Durably<any, any>): void
}

/**
 * Helper type to transform JobDefinition record to JobHandle record
 */
type TransformToHandles<
  TJobs extends Record<string, JobDefinition<string, unknown, unknown>>,
  TLabels extends Record<string, string> = Record<string, string>,
> = {
  [K in keyof TJobs]: TJobs[K] extends JobDefinition<
    infer TName,
    infer TInput,
    infer TOutput
  >
    ? JobHandle<TName & string, TInput, TOutput, TLabels>
    : never
}

/**
 * Durably instance with type-safe jobs
 */
export interface Durably<
  TJobs extends Record<
    string,
    JobHandle<string, unknown, unknown, Record<string, string>>
  > = Record<string, never>,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /**
   * Registered job handles (type-safe)
   */
  readonly jobs: TJobs

  /**
   * Initialize Durably: run migrations and start the worker
   * This is the recommended way to start Durably.
   * Equivalent to calling migrate() then start().
   * @example
   * ```ts
   * const durably = createDurably({ dialect }).register({ ... })
   * await durably.init()
   * ```
   */
  init(): Promise<void>

  /**
   * Run database migrations
   * This is idempotent and safe to call multiple times
   */
  migrate(): Promise<void>

  /**
   * Get the underlying Kysely database instance
   * Useful for testing and advanced use cases
   */
  readonly db: Kysely<Database>

  /**
   * Storage layer for database operations
   */
  readonly storage: Store<TLabels>

  /**
   * Register an event listener
   * @returns Unsubscribe function
   */
  on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe

  /**
   * Emit an event (auto-assigns timestamp and sequence)
   */
  emit(event: AnyEventInput): void

  /**
   * Register an error handler for listener exceptions
   */
  onError(handler: ErrorHandler): void

  /**
   * Register job definitions and return a new Durably instance with type-safe jobs
   * @example
   * ```ts
   * const durably = createDurably({ dialect })
   *   .register({
   *     importCsv: importCsvJob,
   *     syncUsers: syncUsersJob,
   *   })
   * await durably.migrate()
   * // Usage: durably.jobs.importCsv.trigger({ rows: [...] })
   * ```
   */
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  register<TNewJobs extends Record<string, JobDefinition<string, any, any>>>(
    jobDefs: TNewJobs,
  ): Durably<TJobs & TransformToHandles<TNewJobs, TLabels>, TLabels>

  /**
   * Process a single claimable run.
   */
  processOne(options?: { workerId?: string }): Promise<boolean>

  /**
   * Process runs until the queue appears idle.
   */
  processUntilIdle(options?: {
    workerId?: string
    maxRuns?: number
  }): Promise<number>

  /**
   * Start the worker polling loop
   */
  start(options?: { workerId?: string }): void

  /**
   * Stop the worker after current run completes
   */
  stop(): Promise<void>

  /**
   * Create a fresh run from a completed, failed, or cancelled run
   * @throws Error if run is pending, running, or does not exist
   */
  retrigger(runId: string): Promise<Run<TLabels>>

  /**
   * Cancel a pending or running run
   * @throws Error if run is already completed, failed, or cancelled
   */
  cancel(runId: string): Promise<void>

  /**
   * Delete a completed, failed, or cancelled run and its associated steps and logs
   * @throws Error if run is pending or running, or does not exist
   */
  deleteRun(runId: string): Promise<void>

  /**
   * Get a run by ID
   * @example
   * ```ts
   * // Untyped (returns Run)
   * const run = await durably.getRun(runId)
   *
   * // Typed (returns custom type)
   * type MyRun = Run & { input: { userId: string }; output: { count: number } | null }
   * const typedRun = await durably.getRun<MyRun>(runId)
   * ```
   */
  getRun<T extends Run<TLabels> = Run<TLabels>>(
    runId: string,
  ): Promise<T | null>

  /**
   * Get runs with optional filtering
   * @example
   * ```ts
   * // Untyped (returns Run[])
   * const runs = await durably.getRuns({ status: 'completed' })
   *
   * // Typed (returns custom type[])
   * type MyRun = Run & { input: { userId: string }; output: { count: number } | null }
   * const typedRuns = await durably.getRuns<MyRun>({ jobName: 'my-job' })
   * ```
   */
  getRuns<T extends Run<TLabels> = Run<TLabels>>(
    filter?: RunFilter<TLabels>,
  ): Promise<T[]>

  /**
   * Register a plugin
   */
  use(plugin: DurablyPlugin): void

  /**
   * Get a registered job handle by name
   * Returns undefined if job is not registered
   */
  getJob<TName extends string = string>(
    name: TName,
  ): JobHandle<TName, Record<string, unknown>, unknown, TLabels> | undefined

  /**
   * Subscribe to events for a specific run
   * Returns a ReadableStream that can be used for SSE
   */
  subscribe(runId: string): ReadableStream<DurablyEvent>
}

/**
 * Internal state shared across Durably instances
 */
interface DurablyState<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  db: Kysely<Database>
  storage: Store<TLabels>
  eventEmitter: EventEmitter
  jobRegistry: JobRegistry
  worker: Worker
  labelsSchema: z.ZodType | undefined
  preserveSteps: boolean
  migrating: Promise<void> | null
  migrated: boolean
  leaseMs: number
  leaseRenewIntervalMs: number
  backend: DatabaseBackend
  releaseBrowserSingleton: () => void
}

/**
 * Create a Durably instance implementation
 */
function createDurablyInstance<
  TJobs extends Record<
    string,
    JobHandle<string, unknown, unknown, Record<string, string>>
  >,
  TLabels extends Record<string, string> = Record<string, string>,
>(state: DurablyState<TLabels>, jobs: TJobs): Durably<TJobs, TLabels> {
  const {
    db,
    storage,
    eventEmitter,
    jobRegistry,
    worker,
    releaseBrowserSingleton,
  } = state

  async function getRunOrThrow(runId: string): Promise<Run<TLabels>> {
    const run = await storage.getRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }
    return run as Run<TLabels>
  }

  async function executeRun(
    run: Run<TLabels>,
    workerId: string,
  ): Promise<void> {
    const job = jobRegistry.get(run.jobName)
    if (!job) {
      await storage.failRun(
        run.id,
        run.leaseGeneration,
        `Unknown job: ${run.jobName}`,
        new Date().toISOString(),
      )
      return
    }

    const { step, abortLeaseOwnership, dispose } = createStepContext(
      run,
      run.jobName,
      run.leaseGeneration,
      storage,
      eventEmitter,
    )
    let leaseDeadlineTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleLeaseDeadline = (leaseExpiresAt: string | null) => {
      if (leaseDeadlineTimer) {
        clearTimeout(leaseDeadlineTimer)
        leaseDeadlineTimer = null
      }

      if (!leaseExpiresAt) {
        return
      }

      const delay = Math.max(0, Date.parse(leaseExpiresAt) - Date.now())
      leaseDeadlineTimer = setTimeout(() => {
        abortLeaseOwnership()
      }, delay)
    }

    scheduleLeaseDeadline(run.leaseExpiresAt)

    const leaseTimer = setInterval(() => {
      const now = new Date().toISOString()
      storage
        .renewLease(run.id, run.leaseGeneration, now, state.leaseMs)
        .then((renewed) => {
          if (!renewed) {
            abortLeaseOwnership()
            eventEmitter.emit({
              type: 'worker:error',
              error: `Lease renewal lost ownership for run ${run.id}`,
              context: 'lease-renewal',
              runId: run.id,
            })
            return
          }

          const renewedLeaseExpiresAt = new Date(
            Date.parse(now) + state.leaseMs,
          ).toISOString()

          scheduleLeaseDeadline(renewedLeaseExpiresAt)

          eventEmitter.emit({
            type: 'run:lease-renewed',
            runId: run.id,
            jobName: run.jobName,
            leaseOwner: workerId,
            leaseExpiresAt: renewedLeaseExpiresAt,
            labels: run.labels,
          })
        })
        .catch((error) => {
          eventEmitter.emit({
            type: 'worker:error',
            error: getErrorMessage(error),
            context: 'lease-renewal',
            runId: run.id,
          })
        })
    }, state.leaseRenewIntervalMs)

    const started = Date.now()
    let reachedTerminalState = false

    try {
      eventEmitter.emit({
        type: 'run:leased',
        runId: run.id,
        jobName: run.jobName,
        input: run.input,
        leaseOwner: workerId,
        leaseExpiresAt: run.leaseExpiresAt ?? new Date().toISOString(),
        labels: run.labels,
      })
      const output = await job.fn(step, run.input)

      if (job.outputSchema) {
        const parseResult = job.outputSchema.safeParse(output)
        if (!parseResult.success) {
          throw new Error(`Invalid output: ${parseResult.error.message}`)
        }
      }

      const completedAt = new Date().toISOString()
      const completed = await storage.completeRun(
        run.id,
        run.leaseGeneration,
        output,
        completedAt,
      )

      if (completed) {
        reachedTerminalState = true
        eventEmitter.emit({
          type: 'run:complete',
          runId: run.id,
          jobName: run.jobName,
          output,
          duration: Date.now() - started,
          labels: run.labels,
        })
      } else {
        eventEmitter.emit({
          type: 'worker:error',
          error: `Lease lost before completing run ${run.id}`,
          context: 'run-completion',
        })
      }
    } catch (error) {
      if (error instanceof LeaseLostError || error instanceof CancelledError) {
        return
      }

      const errorMessage = getErrorMessage(error)
      const completedAt = new Date().toISOString()
      const failed = await storage.failRun(
        run.id,
        run.leaseGeneration,
        errorMessage,
        completedAt,
      )

      if (failed) {
        reachedTerminalState = true
        const steps = await storage.getSteps(run.id)
        const failedStep = steps.find((entry) => entry.status === 'failed')
        eventEmitter.emit({
          type: 'run:fail',
          runId: run.id,
          jobName: run.jobName,
          error: errorMessage,
          failedStepName: failedStep?.name ?? 'unknown',
          labels: run.labels,
        })
      } else {
        eventEmitter.emit({
          type: 'worker:error',
          error: `Lease lost before recording failure for run ${run.id}`,
          context: 'run-failure',
        })
      }
    } finally {
      clearInterval(leaseTimer)
      if (leaseDeadlineTimer) {
        clearTimeout(leaseDeadlineTimer)
      }
      dispose()
      if (!state.preserveSteps && reachedTerminalState) {
        await storage.deleteSteps(run.id)
      }
    }
  }

  const durably: Durably<TJobs, TLabels> = {
    db,
    storage,
    jobs,
    on: eventEmitter.on,
    emit: eventEmitter.emit,
    onError: eventEmitter.onError,
    start: worker.start,
    async stop(): Promise<void> {
      releaseBrowserSingleton()
      await worker.stop()
    },

    // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
    register<TNewJobs extends Record<string, JobDefinition<string, any, any>>>(
      jobDefs: TNewJobs,
    ): Durably<TJobs & TransformToHandles<TNewJobs, TLabels>, TLabels> {
      const newHandles = {} as TransformToHandles<TNewJobs, TLabels>

      for (const key of Object.keys(jobDefs) as (keyof TNewJobs)[]) {
        const jobDef = jobDefs[key]
        const handle = createJobHandle(
          jobDef,
          storage,
          eventEmitter,
          jobRegistry,
          state.labelsSchema as z.ZodType<TLabels> | undefined,
        )
        newHandles[key] = handle as TransformToHandles<
          TNewJobs,
          TLabels
        >[typeof key]
      }

      // Create new instance with merged jobs
      const mergedJobs = { ...jobs, ...newHandles } as TJobs &
        TransformToHandles<TNewJobs, TLabels>
      return createDurablyInstance<typeof mergedJobs, TLabels>(
        state,
        mergedJobs,
      )
    },

    getRun: storage.getRun.bind(storage),
    getRuns: storage.getRuns.bind(storage),

    use(plugin: DurablyPlugin): void {
      plugin.install(durably)
    },

    getJob<TName extends string = string>(
      name: TName,
    ): JobHandle<TName, Record<string, unknown>, unknown, TLabels> | undefined {
      const registeredJob = jobRegistry.get(name)
      if (!registeredJob) {
        return undefined
      }
      return registeredJob.handle as JobHandle<
        TName,
        Record<string, unknown>,
        unknown,
        TLabels
      >
    },

    subscribe(runId: string): ReadableStream<DurablyEvent> {
      // Track closed state and cleanup function in outer scope for cancel handler
      let closed = false
      let cleanup: (() => void) | null = null

      // Events that close the stream after enqueuing
      const closeEvents = new Set<EventType>(['run:complete', 'run:delete'])
      // All event types to subscribe to for a run
      const subscribedEvents: EventType[] = [
        'run:leased',
        'run:complete',
        'run:fail',
        'run:cancel',
        'run:delete',
        'run:progress',
        'step:start',
        'step:complete',
        'step:fail',
        'log:write',
      ]

      return new ReadableStream<DurablyEvent>({
        start: (controller) => {
          const unsubscribes = subscribedEvents.map((type) =>
            eventEmitter.on(type, (event) => {
              if (closed || event.runId !== runId) return
              controller.enqueue(event)
              if (closeEvents.has(type)) {
                closed = true
                cleanup?.()
                controller.close()
              }
            }),
          )

          cleanup = () => {
            for (const unsub of unsubscribes) unsub()
          }
        },
        cancel: () => {
          // Clean up event listeners when stream is cancelled by consumer
          if (!closed) {
            closed = true
            cleanup?.()
          }
        },
      })
    },

    async retrigger(runId: string): Promise<Run<TLabels>> {
      const run = await getRunOrThrow(runId)
      if (run.status === 'pending') {
        throw new Error(`Cannot retrigger pending run: ${runId}`)
      }
      if (run.status === 'leased') {
        throw new Error(`Cannot retrigger leased run: ${runId}`)
      }
      if (!jobRegistry.get(run.jobName)) {
        throw new Error(`Unknown job: ${run.jobName}`)
      }

      const nextRun = await storage.enqueue({
        jobName: run.jobName,
        input: run.input,
        concurrencyKey: run.concurrencyKey ?? undefined,
        labels: run.labels,
      })

      eventEmitter.emit({
        type: 'run:trigger',
        runId: nextRun.id,
        jobName: run.jobName,
        input: run.input,
        labels: run.labels,
      })

      return nextRun as Run<TLabels>
    },

    async cancel(runId: string): Promise<void> {
      const run = await getRunOrThrow(runId)
      if (run.status === 'completed') {
        throw new Error(`Cannot cancel completed run: ${runId}`)
      }
      if (run.status === 'failed') {
        throw new Error(`Cannot cancel failed run: ${runId}`)
      }
      if (run.status === 'cancelled') {
        throw new Error(`Cannot cancel already cancelled run: ${runId}`)
      }
      const wasPending = run.status === 'pending'
      const cancelled = await storage.cancelRun(runId, new Date().toISOString())

      if (!cancelled) {
        // Run transitioned to a terminal state between the check and the update
        const current = await getRunOrThrow(runId)
        throw new Error(
          `Cannot cancel run ${runId}: status changed to ${current.status}`,
        )
      }

      // For pending runs, no worker will clean up steps, so do it here
      if (wasPending && !state.preserveSteps) {
        await storage.deleteSteps(runId)
      }

      // Emit run:cancel event
      eventEmitter.emit({
        type: 'run:cancel',
        runId,
        jobName: run.jobName,
        labels: run.labels,
      })
    },

    async deleteRun(runId: string): Promise<void> {
      const run = await getRunOrThrow(runId)
      if (run.status === 'pending') {
        throw new Error(`Cannot delete pending run: ${runId}`)
      }
      if (run.status === 'leased') {
        throw new Error(`Cannot delete leased run: ${runId}`)
      }
      await storage.deleteRun(runId)

      // Emit run:delete event
      eventEmitter.emit({
        type: 'run:delete',
        runId,
        jobName: run.jobName,
        labels: run.labels,
      })
    },

    async processOne(options?: { workerId?: string }): Promise<boolean> {
      const workerId = options?.workerId ?? defaultWorkerId()
      const now = new Date().toISOString()

      await storage.releaseExpiredLeases(now)

      const leasedRuns = await storage.getRuns({ status: 'leased' })
      const excludeConcurrencyKeys = leasedRuns
        .filter(
          (entry): entry is Run<TLabels> & { concurrencyKey: string } =>
            entry.concurrencyKey !== null &&
            entry.leaseExpiresAt !== null &&
            entry.leaseExpiresAt > now,
        )
        .map((entry) => entry.concurrencyKey)

      const run = await storage.claimNext(workerId, now, state.leaseMs, {
        excludeConcurrencyKeys,
      })
      if (!run) {
        return false
      }

      await executeRun(run, workerId)
      return true
    },

    async processUntilIdle(options?: {
      workerId?: string
      maxRuns?: number
    }): Promise<number> {
      const workerId = options?.workerId ?? defaultWorkerId()
      const maxRuns = options?.maxRuns ?? Number.POSITIVE_INFINITY
      let processed = 0

      while (processed < maxRuns) {
        const didProcess = await this.processOne({ workerId })
        if (!didProcess) {
          break
        }
        processed++
      }

      return processed
    },

    async migrate(): Promise<void> {
      if (state.migrated) {
        return
      }

      if (state.migrating) {
        return state.migrating
      }

      state.migrating = runMigrations(db, state.backend)
        .then(() => {
          state.migrated = true
        })
        .finally(() => {
          state.migrating = null
        })

      return state.migrating
    },

    async init(): Promise<void> {
      await this.migrate()
      this.start()
    },
  }

  return durably
}

/**
 * Create a Durably instance
 */
// Overload: with jobs
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
>(
  options: DurablyOptions<TLabels, TJobs> & { jobs: TJobs },
): Durably<TransformToHandles<TJobs, TLabels>, TLabels>

// Overload: without jobs
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
>(options: DurablyOptions<TLabels>): Durably<Record<string, never>, TLabels>

// Implementation
export function createDurably<
  TLabels extends Record<string, string> = Record<string, string>,
  // biome-ignore lint/suspicious/noExplicitAny: flexible type constraint for job definitions
  TJobs extends Record<string, JobDefinition<string, any, any>> = Record<
    string,
    never
  >,
>(
  options: DurablyOptions<TLabels, TJobs>,
):
  | Durably<TransformToHandles<TJobs, TLabels>, TLabels>
  | Durably<Record<string, never>, TLabels> {
  const config = {
    pollingIntervalMs: options.pollingIntervalMs ?? DEFAULTS.pollingIntervalMs,
    leaseRenewIntervalMs:
      options.leaseRenewIntervalMs ?? DEFAULTS.leaseRenewIntervalMs,
    leaseMs: options.leaseMs ?? DEFAULTS.leaseMs,
    preserveSteps: options.preserveSteps ?? DEFAULTS.preserveSteps,
  }

  const db = new Kysely<Database>({ dialect: options.dialect })
  const singletonKey = getBrowserSingletonKey(
    options.dialect,
    options.singletonKey,
  )
  const releaseBrowserSingleton =
    singletonKey !== null
      ? registerBrowserSingletonWarning(singletonKey)
      : () => {}
  const backend = detectBackend(options.dialect)
  const storage = createKyselyStore(db, backend) as Store<TLabels>
  const originalDestroy = db.destroy.bind(db)
  db.destroy = (async () => {
    releaseBrowserSingleton()
    return originalDestroy()
  }) as typeof db.destroy
  const eventEmitter = createEventEmitter()
  const jobRegistry = createJobRegistry()
  let processOneImpl:
    | ((options?: { workerId?: string }) => Promise<boolean>)
    | null = null
  const worker = createWorker(
    { pollingIntervalMs: config.pollingIntervalMs },
    (runtimeOptions) => {
      if (!processOneImpl) {
        throw new Error('Durably runtime is not initialized')
      }
      return processOneImpl(runtimeOptions)
    },
  )

  const state: DurablyState<TLabels> = {
    db,
    storage,
    eventEmitter,
    jobRegistry,
    worker,
    labelsSchema: options.labels,
    preserveSteps: config.preserveSteps,
    migrating: null,
    migrated: false,
    leaseMs: config.leaseMs,
    leaseRenewIntervalMs: config.leaseRenewIntervalMs,
    backend,
    releaseBrowserSingleton,
  }

  const instance = createDurablyInstance<Record<string, never>, TLabels>(
    state,
    {},
  )
  processOneImpl = instance.processOne

  if (options.jobs) {
    return instance.register(options.jobs)
  }

  return instance
}
