import type { JsonValue } from './attempts'
import type { AnyDurably } from './durably'
import { DurablyError, getErrorMessage } from './errors'
import type { AnyEventInput } from './events'
import {
  errorResponse,
  getRequiredQueryParam,
  jsonResponse,
  successResponse,
} from './http'
import type { Disposition } from './job'
import {
  createSSEResponse,
  createSSEStreamFromSubscriptions,
  createThrottledSSEController,
  createThrottledSSEStreamFromReader,
  type SSEStreamController,
} from './sse'
import type { Run, RunFilter, RunStatus } from './storage'
import { toClientRun } from './storage'
import type { DurableWait } from './waits'
import { canonicalWaitJson } from './waits'

/**
 * Run operation types for onRunAccess
 */
export type RunOperation =
  | 'read'
  | 'subscribe'
  | 'steps'
  | 'retrigger'
  | 'cancel'
  | 'delete'
  | 'waits'
  | 'signal'

/**
 * Subscription filter — only fields that SSE subscriptions actually support.
 */
export type RunsSubscribeFilter<
  TLabels extends Record<string, string> = Record<string, string>,
> = Pick<RunFilter<TLabels>, 'jobName' | 'labels'>

/**
 * Request body for triggering a job
 */
export interface TriggerRequest<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
  coalesce?: 'skip' | 'queue' | 'active'
}

/**
 * Response for trigger endpoint
 */
export interface TriggerResponse {
  runId: string
  disposition: Disposition
  status: RunStatus
}

/**
 * Auth middleware configuration.
 * When `auth` is set, `authenticate` is required.
 * TContext is inferred from authenticate's return type.
 * TLabels is inferred from the Durably instance.
 */
export interface AuthConfig<
  TContext,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /** Authenticate every request. Return context or throw Response to reject. */
  authenticate: (request: Request) => Promise<TContext> | TContext

  /** Guard before trigger. Called after body validation and job resolution. */
  onTrigger?: (
    ctx: TContext,
    trigger: TriggerRequest<TLabels>,
  ) => Promise<void> | void

  /** Guard before run-level operations. Run is pre-fetched. */
  onRunAccess?: (
    ctx: TContext,
    run: Run<TLabels>,
    info: { operation: RunOperation },
  ) => Promise<void> | void

  /** Validate and authorize a wait signal before it is persisted. */
  onSignal?: (
    ctx: TContext,
    run: Run<TLabels>,
    wait: DurableWait,
    signal: { signalId: string; payload: JsonValue },
  ) => Promise<void> | void

  /** Scope runs list queries (GET /runs). */
  scopeRuns?: (
    ctx: TContext,
    filter: RunFilter<TLabels>,
  ) => RunFilter<TLabels> | Promise<RunFilter<TLabels>>

  /** Scope GET /runs/subscribe. Required with onRunAccess; otherwise scopeRuns may be used if it returns only stream-compatible filters. */
  scopeRunsSubscribe?: (
    ctx: TContext,
    filter: RunsSubscribeFilter<TLabels>,
  ) => RunsSubscribeFilter<TLabels> | Promise<RunsSubscribeFilter<TLabels>>
}

/**
 * Handler interface for HTTP endpoints
 */
export interface DurablyHandler {
  /**
   * Handle all Durably HTTP requests with automatic routing + auth
   *
   * Routes:
   * - GET  {basePath}/subscribe?runId=xxx - SSE stream
   * - GET  {basePath}/runs - List runs
   * - GET  {basePath}/runs/subscribe - SSE stream of run updates
   * - GET  {basePath}/run?runId=xxx - Get single run
   * - GET  {basePath}/steps?runId=xxx - Get steps
   * - GET  {basePath}/waits?runId=xxx - List waits for a run
   * - GET  {basePath}/wait?runId=xxx&waitId=xxx - Get a wait
   * - POST {basePath}/signal?runId=xxx&waitId=xxx - Resolve a wait
   * - POST {basePath}/trigger - Trigger a job
   * - POST {basePath}/retrigger?runId=xxx - Create a fresh run from a terminal run
   * - POST {basePath}/cancel?runId=xxx - Cancel a run
   * - DELETE {basePath}/run?runId=xxx - Delete a run
   */
  handle(request: Request, basePath: string): Promise<Response>
}

/**
 * Options for createDurablyHandler
 */
export interface CreateDurablyHandlerOptions<
  TContext = undefined,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /**
   * Called before handling each request (after authentication).
   * Use this to initialize Durably (migrate, start worker, etc.)
   */
  onRequest?: () => Promise<void> | void

  /**
   * Throttle interval in milliseconds for SSE progress events.
   * @default 100
   */
  sseThrottleMs?: number

  /**
   * Auth middleware. When set, authenticate is required and auth applies to ALL endpoints.
   */
  auth?: AuthConfig<TContext, TLabels>
}

/**
 * Valid status values for runs
 */
const VALID_STATUSES = [
  'waiting',
  'pending',
  'leased',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly RunStatus[]

const VALID_STATUSES_SET: ReadonlySet<string> = new Set(VALID_STATUSES)

/**
 * Parse label.* query params into a Record<string, string>
 */
function parseLabelsFromParams(
  searchParams: URLSearchParams,
): Record<string, string> | undefined {
  const labels: Record<string, string> = Object.create(null)
  for (const [key, value] of searchParams.entries()) {
    if (key.startsWith('label.')) {
      labels[key.slice(6)] = value
    }
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

/**
 * Parse and validate RunFilter from query params.
 * Returns the filter or an error Response.
 */
function parseRunFilter(url: URL): RunFilter | Response {
  const jobNames = url.searchParams.getAll('jobName')
  const statusParams = url.searchParams.getAll('status')
  const limitParam = url.searchParams.get('limit')
  const offsetParam = url.searchParams.get('offset')
  const labels = parseLabelsFromParams(url.searchParams)

  let status: RunFilter['status'] | undefined
  if (statusParams.length > 0) {
    for (const s of statusParams) {
      if (s === '') {
        return errorResponse(
          `Invalid status: empty value. Must be one of: ${VALID_STATUSES.join(', ')}`,
          400,
        )
      }
      if (!VALID_STATUSES_SET.has(s)) {
        return errorResponse(
          `Invalid status: ${s}. Must be one of: ${VALID_STATUSES.join(', ')}`,
          400,
        )
      }
    }
    status =
      statusParams.length === 1
        ? (statusParams[0] as RunStatus)
        : (statusParams as RunStatus[])
  }

  // Validate limit
  let limit: number | undefined
  if (limitParam) {
    limit = Number.parseInt(limitParam, 10)
    if (Number.isNaN(limit) || limit < 0) {
      return errorResponse('Invalid limit: must be a non-negative integer', 400)
    }
  }

  // Validate offset
  let offset: number | undefined
  if (offsetParam) {
    offset = Number.parseInt(offsetParam, 10)
    if (Number.isNaN(offset) || offset < 0) {
      return errorResponse(
        'Invalid offset: must be a non-negative integer',
        400,
      )
    }
  }

  return {
    jobName: jobNames.length > 0 ? jobNames : undefined,
    status,
    labels,
    limit,
    offset,
  }
}

/**
 * Parse RunsSubscribeFilter from query params.
 */
function parseRunsSubscribeFilter(url: URL): RunsSubscribeFilter {
  const jobNames = url.searchParams.getAll('jobName')
  const labels = parseLabelsFromParams(url.searchParams)

  return {
    jobName: jobNames.length > 0 ? jobNames : undefined,
    labels,
  }
}

/** Validate a hook result before it can become a global event stream. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validJobNameScope(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length > 0) ||
    (Array.isArray(value) &&
      value.every((name) => typeof name === 'string' && name.length > 0))
  )
}

function validLabelsScope(value: unknown): boolean {
  return (
    value === undefined ||
    (isPlainRecord(value) &&
      Object.values(value).every((label) => typeof label === 'string'))
  )
}

function checkedRunListFilter(value: unknown): RunFilter | Response {
  if (!isPlainRecord(value))
    return errorResponse('Run list scope must be an object', 400)
  if (
    Object.keys(value).some(
      (key) =>
        !['jobName', 'labels', 'status', 'limit', 'offset'].includes(key),
    )
  ) {
    return errorResponse('Run list scope contains an unsupported field', 400)
  }
  if (!validJobNameScope(value.jobName) || !validLabelsScope(value.labels))
    return errorResponse('Invalid run list scope', 400)
  const status = value.status
  if (
    status !== undefined &&
    !(
      (typeof status === 'string' && VALID_STATUSES_SET.has(status)) ||
      (Array.isArray(status) &&
        status.every(
          (item) => typeof item === 'string' && VALID_STATUSES_SET.has(item),
        ))
    )
  ) {
    return errorResponse('Invalid run list status scope', 400)
  }
  for (const key of ['limit', 'offset']) {
    const field = value[key]
    if (
      field !== undefined &&
      (!Number.isSafeInteger(field) || (field as number) < 0)
    ) {
      return errorResponse(`Invalid run list ${key} scope`, 400)
    }
  }
  return value as RunFilter
}

function checkedRunsSubscribeFilter(
  value: unknown,
  fromRunsList = false,
): RunsSubscribeFilter | Response {
  if (!isPlainRecord(value)) {
    return errorResponse('Run subscription scope must be an object', 400)
  }

  const filter = value as Record<string, unknown>
  for (const [key, field] of Object.entries(filter)) {
    if (key === 'jobName' || key === 'labels') continue
    if (
      fromRunsList &&
      (key === 'status' || key === 'limit' || key === 'offset') &&
      field === undefined
    ) {
      continue
    }
    return errorResponse(`Run subscription cannot enforce ${key}`, 400)
  }

  const jobName = filter.jobName
  if (!validJobNameScope(jobName)) {
    return errorResponse('Invalid run subscription jobName scope', 400)
  }

  const labels = filter.labels
  if (!validLabelsScope(labels)) {
    return errorResponse('Invalid run subscription labels scope', 400)
  }

  return { jobName, labels } as RunsSubscribeFilter
}

/**
 * Check if event labels match filter labels (all filter labels must match)
 */
function matchesLabels(
  eventLabels: Record<string, string>,
  filterLabels: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(filterLabels)) {
    if (eventLabels[key] !== value) return false
  }
  return true
}

/**
 * Create HTTP handlers for Durably
 * Uses Web Standard Request/Response for framework-agnostic usage
 */
export function createDurablyHandler<
  TContext = undefined,
  TLabels extends Record<string, string> = Record<string, string>,
>(
  durably: AnyDurably<TLabels>,
  options?: CreateDurablyHandlerOptions<TContext, TLabels>,
): DurablyHandler {
  const throttleMs = options?.sseThrottleMs ?? 100
  const auth = options?.auth

  // Validate: auth requires authenticate
  if (auth && !auth.authenticate) {
    throw new Error(
      'createDurablyHandler: auth.authenticate is required when auth is provided',
    )
  }

  // --- Shared helpers ---

  /** Wrap handler with try/catch that maps DurablyError to proper HTTP status */
  async function withErrorHandling(
    fn: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof Response) throw error
      if (error instanceof DurablyError) {
        return errorResponse(
          error.message,
          error.statusCode as 400 | 404 | 409 | 410 | 500,
        )
      }
      return errorResponse(getErrorMessage(error), 500)
    }
  }

  /** Fetch run, check auth, return run or error Response */
  async function requireRunAccess(
    url: URL,
    ctx: TContext | undefined,
    operation: RunOperation,
  ): Promise<{ run: Run<TLabels>; runId: string } | Response> {
    const runId = getRequiredQueryParam(url, 'runId')
    if (runId instanceof Response) return runId

    const run = await durably.getRun(runId)
    if (!run) return errorResponse('Run not found', 404)

    // Wait addresses must never become capabilities for authenticated deployments.
    if (
      (operation === 'waits' || operation === 'signal') &&
      auth &&
      !auth.onRunAccess
    ) {
      return errorResponse('Wait access requires onRunAccess', 400)
    }

    if (auth?.onRunAccess) {
      await auth.onRunAccess(ctx as TContext, run as Run<TLabels>, {
        operation,
      })
    }

    return { run: run as Run<TLabels>, runId }
  }

  // --- Private endpoint handlers (closure-scoped, not exposed on returned object) ---

  async function handleTrigger(
    request: Request,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const body = (await request.json()) as TriggerRequest<TLabels>

      if (!body.jobName) {
        return errorResponse('jobName is required', 400)
      }

      const job = durably.getJob(body.jobName)
      if (!job) {
        return errorResponse(`Job not found: ${body.jobName}`, 404)
      }

      // Auth hook: onTrigger (after validation)
      if (auth?.onTrigger) {
        await auth.onTrigger(ctx as TContext, body)
      }

      const run = await job.trigger(body.input as Record<string, unknown>, {
        idempotencyKey: body.idempotencyKey,
        concurrencyKey: body.concurrencyKey,
        labels: body.labels,
        coalesce: body.coalesce,
      })

      const response: TriggerResponse = {
        runId: run.id,
        disposition: run.disposition,
        status: run.status,
      }
      return jsonResponse(response)
    })
  }

  async function handleSubscribe(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    const result = await requireRunAccess(url, ctx, 'subscribe')
    if (result instanceof Response) return result

    const stream = durably.subscribe(result.runId)
    const sseStream = createThrottledSSEStreamFromReader(
      stream.getReader() as ReadableStreamDefaultReader<AnyEventInput>,
      throttleMs,
    )
    return createSSEResponse(sseStream)
  }

  async function handleRuns(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const filterOrError = parseRunFilter(url)
      if (filterOrError instanceof Response) return filterOrError

      let filter: RunFilter<TLabels> = filterOrError as RunFilter<TLabels>

      // Auth hook: scopeRuns
      if (auth?.scopeRuns) {
        const scoped = checkedRunListFilter(
          await auth.scopeRuns(ctx as TContext, filter),
        )
        if (scoped instanceof Response) return scoped
        filter = scoped as RunFilter<TLabels>
      }

      const runs = await durably.getRuns(filter)
      return jsonResponse(runs.map(toClientRun))
    })
  }

  async function handleRun(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'read')
      if (result instanceof Response) return result

      return jsonResponse(toClientRun(result.run))
    })
  }

  async function handleSteps(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'steps')
      if (result instanceof Response) return result

      const steps = await durably.storage.getSteps(result.runId)
      return jsonResponse(steps)
    })
  }

  async function requireWaitAccess(
    url: URL,
    ctx: TContext | undefined,
    operation: 'waits' | 'signal',
  ): Promise<{ run: Run<TLabels>; wait: DurableWait } | Response> {
    const result = await requireRunAccess(url, ctx, operation)
    if (result instanceof Response) return result
    const waitId = getRequiredQueryParam(url, 'waitId')
    if (waitId instanceof Response) return waitId
    const wait = await durably.getWait(waitId)
    if (!wait || wait.runId !== result.runId)
      return errorResponse('Wait not found', 404)
    return { run: result.run, wait }
  }

  async function handleWaits(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'waits')
      if (result instanceof Response) return result
      return jsonResponse(await durably.getWaits(result.runId))
    })
  }

  async function handleWait(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireWaitAccess(url, ctx, 'waits')
      if (result instanceof Response) return result
      return jsonResponse(result.wait)
    })
  }

  async function handleSignal(
    request: Request,
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireWaitAccess(url, ctx, 'signal')
      if (result instanceof Response) return result
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return errorResponse('Invalid JSON body', 400)
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body))
        return errorResponse('Signal body must be an object', 400)
      const fields = body as Record<string, unknown>
      if (typeof fields.signalId !== 'string' || !fields.signalId.trim())
        return errorResponse('signalId must be non-empty', 400)
      if (!Object.hasOwn(fields, 'payload'))
        return errorResponse('payload is required', 400)
      // Keep invalid values out of storage and let the application validate its schema.
      canonicalWaitJson(fields.payload)
      const signal = {
        signalId: fields.signalId,
        payload: fields.payload as JsonValue,
      }
      if (auth?.onSignal)
        await auth.onSignal(ctx as TContext, result.run, result.wait, signal)
      const receipt = await durably.storage.signalWaitDetailed(
        result.wait.id,
        signal.payload,
        { signalId: signal.signalId },
      )
      return jsonResponse(receipt)
    })
  }

  async function handleRetrigger(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'retrigger')
      if (result instanceof Response) return result

      const run = await durably.retrigger(result.runId)
      return jsonResponse({ success: true, runId: run.id })
    })
  }

  async function handleCancel(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'cancel')
      if (result instanceof Response) return result

      await durably.cancel(result.runId)
      return successResponse()
    })
  }

  async function handleDelete(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    return withErrorHandling(async () => {
      const result = await requireRunAccess(url, ctx, 'delete')
      if (result instanceof Response) return result

      await durably.deleteRun(result.runId)
      return successResponse()
    })
  }

  async function handleRunsSubscribe(
    url: URL,
    ctx: TContext | undefined,
  ): Promise<Response> {
    const parsed = parseRunsSubscribeFilter(url) as RunsSubscribeFilter<TLabels>
    if (!auth) return createRunsSSEStream(parsed)

    let scoped: unknown
    let fromRunsList = false
    if (auth.scopeRunsSubscribe) {
      scoped = await auth.scopeRunsSubscribe(ctx as TContext, parsed)
    } else if (auth.onRunAccess) {
      return errorResponse('Run subscription requires scopeRunsSubscribe', 400)
    } else if (auth.scopeRuns) {
      scoped = await auth.scopeRuns(ctx as TContext, parsed)
      fromRunsList = true
    } else {
      return errorResponse('Run subscription requires a scope hook', 400)
    }

    const filter = checkedRunsSubscribeFilter(scoped, fromRunsList)
    if (filter instanceof Response) return filter
    return createRunsSSEStream(filter)
  }

  function createRunsSSEStream(filter: RunsSubscribeFilter): Response {
    const jobNameFilter = Array.isArray(filter.jobName)
      ? filter.jobName
      : filter.jobName === undefined
        ? undefined
        : [filter.jobName]
    const labelsFilter = filter.labels

    const matchesFilter = (
      jobName: string,
      labels?: Record<string, string>,
    ) => {
      if (jobNameFilter && !jobNameFilter.includes(jobName)) return false
      if (
        labelsFilter &&
        (!labels ||
          !matchesLabels(labels, labelsFilter as Record<string, string>))
      )
        return false
      return true
    }

    const sseStream = createSSEStreamFromSubscriptions(
      (innerCtrl: SSEStreamController) => {
        const { controller: ctrl, dispose } = createThrottledSSEController(
          innerCtrl,
          throttleMs,
        )

        const unsubscribes = [
          durably.on('run:trigger', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:trigger',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:coalesced', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:coalesced',
                runId: event.runId,
                jobName: event.jobName,
                status: event.status,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:waiting', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:waiting',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
                waitId: event.waitId,
              })
            }
          }),

          durably.on('run:leased', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:leased',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:complete', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:complete',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:fail', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:fail',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:cancel', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:cancel',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:delete', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:delete',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
              })
            }
          }),

          durably.on('run:progress', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'run:progress',
                runId: event.runId,
                jobName: event.jobName,
                progress: event.progress,
                labels: event.labels,
              })
            }
          }),

          durably.on('step:start', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'step:start',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
                labels: event.labels,
              })
            }
          }),

          durably.on('step:complete', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'step:complete',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
                labels: event.labels,
              })
            }
          }),

          durably.on('step:fail', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'step:fail',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
                error: event.error,
                labels: event.labels,
              })
            }
          }),

          durably.on('step:cancel', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'step:cancel',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
                labels: event.labels,
              })
            }
          }),

          durably.on('log:write', (event) => {
            if (matchesFilter(event.jobName, event.labels)) {
              ctrl.enqueue({
                type: 'log:write',
                runId: event.runId,
                jobName: event.jobName,
                labels: event.labels,
                stepName: event.stepName,
                level: event.level,
                message: event.message,
                data: event.data,
              })
            }
          }),
        ]

        return [...unsubscribes, dispose]
      },
    )

    return createSSEResponse(sseStream)
  }

  // --- Public API: only handle() ---

  return {
    async handle(request: Request, basePath: string): Promise<Response> {
      try {
        // 1. Authenticate (fail fast before anything else)
        let ctx: TContext | undefined
        if (auth?.authenticate) {
          ctx = await auth.authenticate(request)
        }

        // 2. Run onRequest hook (lazy init: migrations, worker start)
        if (options?.onRequest) {
          await options.onRequest()
        }

        // 3. Route by path + method
        const url = new URL(request.url)
        const path = url.pathname.replace(basePath, '')
        const method = request.method

        // GET routes
        if (method === 'GET') {
          if (path === '/subscribe') return await handleSubscribe(url, ctx)
          if (path === '/runs') return await handleRuns(url, ctx)
          if (path === '/run') return await handleRun(url, ctx)
          if (path === '/steps') return await handleSteps(url, ctx)
          if (path === '/waits') return await handleWaits(url, ctx)
          if (path === '/wait') return await handleWait(url, ctx)
          if (path === '/runs/subscribe')
            return await handleRunsSubscribe(url, ctx)
        }

        // POST routes
        if (method === 'POST') {
          if (path === '/trigger') return await handleTrigger(request, ctx)
          if (path === '/retrigger') return await handleRetrigger(url, ctx)
          if (path === '/cancel') return await handleCancel(url, ctx)
          if (path === '/signal') return await handleSignal(request, url, ctx)
        }

        // DELETE routes
        if (method === 'DELETE') {
          if (path === '/run') return await handleDelete(url, ctx)
        }

        return new Response('Not Found', { status: 404 })
      } catch (error) {
        // Auth hooks throw Response to reject — return as-is
        if (error instanceof Response) return error
        return errorResponse(getErrorMessage(error), 500)
      }
    },
  }
}
