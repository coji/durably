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
  createSSEStreamFromReader,
  createSSEStreamFromSubscriptions,
  type SSEStreamController,
} from './sse'

/**
 * Request body for triggering a job
 */
export interface TriggerRequest {
  jobName: string
  input: Record<string, unknown>
  idempotencyKey?: string
  concurrencyKey?: string
}

/**
 * Response for trigger endpoint
 */
export interface TriggerResponse {
  runId: string
}

/**
 * Request query params for listing runs
 */
export interface RunsRequest {
  jobName?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  limit?: number
  offset?: number
}

/**
 * Handler interface for HTTP endpoints
 */
export interface DurablyHandler {
  /**
   * Handle all Durably HTTP requests with automatic routing
   *
   * Routes:
   * - GET  {basePath}/subscribe?runId=xxx - SSE stream
   * - GET  {basePath}/runs - List runs
   * - GET  {basePath}/run?runId=xxx - Get single run
   * - POST {basePath}/trigger - Trigger a job
   * - POST {basePath}/retry?runId=xxx - Retry a failed run
   * - POST {basePath}/cancel?runId=xxx - Cancel a run
   *
   * @param request - The incoming HTTP request
   * @param basePath - The base path to strip from the URL (e.g., '/api/durably')
   * @returns Response or null if route not matched
   *
   * @example
   * ```ts
   * // React Router / Remix
   * export async function loader({ request }) {
   *   return durablyHandler.handle(request, '/api/durably')
   * }
   * export async function action({ request }) {
   *   return durablyHandler.handle(request, '/api/durably')
   * }
   * ```
   */
  handle(request: Request, basePath: string): Promise<Response>

  /**
   * Handle job trigger request
   * Expects POST with JSON body: { jobName, input, idempotencyKey?, concurrencyKey? }
   * Returns JSON: { runId }
   */
  trigger(request: Request): Promise<Response>

  /**
   * Handle subscription request
   * Expects GET with query param: runId
   * Returns SSE stream of events
   */
  subscribe(request: Request): Response

  /**
   * Handle runs list request
   * Expects GET with optional query params: jobName, status, limit, offset
   * Returns JSON array of runs
   */
  runs(request: Request): Promise<Response>

  /**
   * Handle single run request
   * Expects GET with query param: runId
   * Returns JSON run object or 404
   */
  run(request: Request): Promise<Response>

  /**
   * Handle retry request
   * Expects POST with query param: runId
   * Returns JSON: { success: true }
   */
  retry(request: Request): Promise<Response>

  /**
   * Handle cancel request
   * Expects POST with query param: runId
   * Returns JSON: { success: true }
   */
  cancel(request: Request): Promise<Response>

  /**
   * Handle delete request
   * Expects DELETE with query param: runId
   * Returns JSON: { success: true }
   */
  delete(request: Request): Promise<Response>

  /**
   * Handle steps request
   * Expects GET with query param: runId
   * Returns JSON array of steps
   */
  steps(request: Request): Promise<Response>

  /**
   * Handle runs subscription request
   * Expects GET with optional query param: jobName
   * Returns SSE stream of run update notifications
   */
  runsSubscribe(request: Request): Response
}

/**
 * Options for createDurablyHandler
 */
export interface CreateDurablyHandlerOptions {
  /**
   * Called before handling each request.
   * Use this to initialize Durably (migrate, start worker, etc.)
   *
   * @example
   * ```ts
   * const durablyHandler = createDurablyHandler(durably, {
   *   onRequest: async () => {
   *     await durably.migrate()
   *     durably.start()
   *   }
   * })
   * ```
   */
  onRequest?: () => Promise<void> | void
}

/**
 * Create HTTP handlers for Durably
 * Uses Web Standard Request/Response for framework-agnostic usage
 */
export function createDurablyHandler(
  durably: Durably,
  options?: CreateDurablyHandlerOptions,
): DurablyHandler {
  const handler: DurablyHandler = {
    async handle(request: Request, basePath: string): Promise<Response> {
      // Run onRequest hook if provided
      if (options?.onRequest) {
        await options.onRequest()
      }

      const url = new URL(request.url)
      const path = url.pathname.replace(basePath, '')
      const method = request.method

      // GET routes
      if (method === 'GET') {
        if (path === '/subscribe') return handler.subscribe(request)
        if (path === '/runs') return handler.runs(request)
        if (path === '/run') return handler.run(request)
        if (path === '/steps') return handler.steps(request)
        if (path === '/runs/subscribe') return handler.runsSubscribe(request)
      }

      // POST routes
      if (method === 'POST') {
        if (path === '/trigger') return handler.trigger(request)
        if (path === '/retry') return handler.retry(request)
        if (path === '/cancel') return handler.cancel(request)
      }

      // DELETE routes
      if (method === 'DELETE') {
        if (path === '/run') return handler.delete(request)
      }

      return new Response('Not Found', { status: 404 })
    },

    async trigger(request: Request): Promise<Response> {
      try {
        const body = (await request.json()) as TriggerRequest

        if (!body.jobName) {
          return errorResponse('jobName is required', 400)
        }

        const job = durably.getJob(body.jobName)
        if (!job) {
          return errorResponse(`Job not found: ${body.jobName}`, 404)
        }

        const run = await job.trigger(body.input ?? {}, {
          idempotencyKey: body.idempotencyKey,
          concurrencyKey: body.concurrencyKey,
        })

        const response: TriggerResponse = { runId: run.id }
        return jsonResponse(response)
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    subscribe(request: Request): Response {
      const url = new URL(request.url)
      const runId = getRequiredQueryParam(url, 'runId')
      if (runId instanceof Response) return runId

      const stream = durably.subscribe(runId)
      const sseStream = createSSEStreamFromReader(
        stream.getReader() as ReadableStreamDefaultReader<AnyEventInput>,
      )

      return createSSEResponse(sseStream)
    },

    async runs(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const jobName = url.searchParams.get('jobName') ?? undefined
        const status = url.searchParams.get('status') as RunsRequest['status']
        const limit = url.searchParams.get('limit')
        const offset = url.searchParams.get('offset')

        const runs = await durably.getRuns({
          jobName,
          status,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
          offset: offset ? Number.parseInt(offset, 10) : undefined,
        })

        return jsonResponse(runs)
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    async run(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = getRequiredQueryParam(url, 'runId')
        if (runId instanceof Response) return runId

        const run = await durably.getRun(runId)

        if (!run) {
          return errorResponse('Run not found', 404)
        }

        return jsonResponse(run)
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    async retry(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = getRequiredQueryParam(url, 'runId')
        if (runId instanceof Response) return runId

        await durably.retry(runId)

        return successResponse()
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    async cancel(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = getRequiredQueryParam(url, 'runId')
        if (runId instanceof Response) return runId

        await durably.cancel(runId)

        return successResponse()
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    async delete(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = getRequiredQueryParam(url, 'runId')
        if (runId instanceof Response) return runId

        await durably.deleteRun(runId)

        return successResponse()
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    async steps(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = getRequiredQueryParam(url, 'runId')
        if (runId instanceof Response) return runId

        const steps = await durably.storage.getSteps(runId)

        return jsonResponse(steps)
      } catch (error) {
        return errorResponse(getErrorMessage(error), 500)
      }
    },

    runsSubscribe(request: Request): Response {
      const url = new URL(request.url)
      const jobNameFilter = url.searchParams.get('jobName')

      // Helper to check job name filter
      const matchesFilter = (jobName: string) =>
        !jobNameFilter || jobName === jobNameFilter

      const sseStream = createSSEStreamFromSubscriptions(
        (ctrl: SSEStreamController) => [
          durably.on('run:trigger', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:trigger',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:start', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:start',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:complete', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:complete',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:fail', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:fail',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:cancel', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:cancel',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:retry', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:retry',
                runId: event.runId,
                jobName: event.jobName,
              })
            }
          }),

          durably.on('run:progress', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'run:progress',
                runId: event.runId,
                jobName: event.jobName,
                progress: event.progress,
              })
            }
          }),

          durably.on('step:start', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'step:start',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
              })
            }
          }),

          durably.on('step:complete', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'step:complete',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
              })
            }
          }),

          durably.on('step:fail', (event) => {
            if (matchesFilter(event.jobName)) {
              ctrl.enqueue({
                type: 'step:fail',
                runId: event.runId,
                jobName: event.jobName,
                stepName: event.stepName,
                stepIndex: event.stepIndex,
                error: event.error,
              })
            }
          }),

          durably.on('log:write', (event) => {
            // log:write doesn't have jobName, so we can't filter by it
            // Send all logs when no filter, or skip if filter is set
            if (!jobNameFilter) {
              ctrl.enqueue({
                type: 'log:write',
                runId: event.runId,
                stepName: event.stepName,
                level: event.level,
                message: event.message,
                data: event.data,
              })
            }
          }),
        ],
      )

      return createSSEResponse(sseStream)
    },
  }

  return handler
}
