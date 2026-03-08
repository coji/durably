import type { Durably } from './durably'
import type { AnyEventInput } from './events'
import {
  errorResponse,
  getErrorMessage,
  getRequiredQueryParam,
  jsonResponse,
  successResponse,
} from './http'
import {
  createSSEResponse,
  createSSEStreamFromSubscriptions,
  createThrottledSSEController,
  createThrottledSSEStreamFromReader,
  type SSEStreamController,
} from './sse'
import type { Run, RunFilter } from './storage'
import { toClientRun } from './storage'

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
}

/**
 * Response for trigger endpoint
 */
export interface TriggerResponse {
  runId: string
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

  /** Scope runs list queries (GET /runs). */
  scopeRuns?: (
    ctx: TContext,
    filter: RunFilter<TLabels>,
  ) => RunFilter<TLabels> | Promise<RunFilter<TLabels>>

  /** Scope runs subscribe stream (GET /runs/subscribe). Falls back to scopeRuns if not set. */
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
  'pending',
  'running',
  'leased',
  'completed',
  'failed',
  'cancelled',
] as const

const VALID_STATUSES_SET: ReadonlySet<string> = new Set(VALID_STATUSES)

/**
 * Parse label.* query params into a Record<string, string>
 */
function parseLabelsFromParams(
  searchParams: URLSearchParams,
): Record<string, string> | undefined {
  const labels: Record<string, string> = {}
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
  const statusParam = url.searchParams.get('status')
  const limitParam = url.searchParams.get('limit')
  const offsetParam = url.searchParams.get('offset')
  const labels = parseLabelsFromParams(url.searchParams)

  // Validate status
  if (statusParam && !VALID_STATUSES_SET.has(statusParam)) {
    return errorResponse(
      `Invalid status: ${statusParam}. Must be one of: ${VALID_STATUSES.join(', ')}`,
      400,
    )
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
    status: statusParam as RunFilter['status'],
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
// biome-ignore lint/suspicious/noExplicitAny: TLabels must be inferred from Durably instance
export function createDurablyHandler<
  TContext = undefined,
  TLabels extends Record<string, string> = Record<string, string>,
>(
  durably: Durably<any, TLabels>,
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

  /** Wrap handler with try/catch that re-throws Response and catches everything else as 500 */
  async function withErrorHandling(
    fn: () => Promise<Response>,
  ): Promise<Response> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof Response) throw error
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

    if (auth?.onRunAccess && ctx !== undefined) {
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
      if (auth?.onTrigger && ctx !== undefined) {
        await auth.onTrigger(ctx as TContext, body)
      }

      const run = await job.trigger(
        (body.input ?? {}) as Record<string, unknown>,
        {
          idempotencyKey: body.idempotencyKey,
          concurrencyKey: body.concurrencyKey,
          labels: body.labels,
        },
      )

      const response: TriggerResponse = { runId: run.id }
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
      if (auth?.scopeRuns && ctx !== undefined) {
        filter = await auth.scopeRuns(ctx as TContext, filter)
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
    let filter: RunsSubscribeFilter<TLabels>

    if (ctx !== undefined && auth?.scopeRunsSubscribe) {
      const parsed = parseRunsSubscribeFilter(
        url,
      ) as RunsSubscribeFilter<TLabels>
      filter = await auth.scopeRunsSubscribe(ctx as TContext, parsed)
    } else if (ctx !== undefined && auth?.scopeRuns) {
      // Fallback: use scopeRuns with subscribe-compatible filter
      const parsed = parseRunsSubscribeFilter(
        url,
      ) as RunsSubscribeFilter<TLabels>
      const scoped = await auth.scopeRuns(
        ctx as TContext,
        {
          ...parsed,
        } as RunFilter<TLabels>,
      )
      filter = { jobName: scoped.jobName, labels: scoped.labels }
    } else {
      filter = parseRunsSubscribeFilter(url) as RunsSubscribeFilter<TLabels>
    }

    return createRunsSSEStream(filter)
  }

  function createRunsSSEStream(filter: RunsSubscribeFilter): Response {
    const jobNameFilter = Array.isArray(filter.jobName)
      ? filter.jobName
      : filter.jobName
        ? [filter.jobName]
        : []
    const labelsFilter = filter.labels

    const matchesFilter = (
      jobName: string,
      labels?: Record<string, string>,
    ) => {
      if (jobNameFilter.length > 0 && !jobNameFilter.includes(jobName))
        return false
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
          if (path === '/runs/subscribe')
            return await handleRunsSubscribe(url, ctx)
        }

        // POST routes
        if (method === 'POST') {
          if (path === '/trigger') return await handleTrigger(request, ctx)
          if (path === '/retrigger') return await handleRetrigger(url, ctx)
          if (path === '/cancel') return await handleCancel(url, ctx)
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
