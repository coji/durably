import type { Durably } from './durably'
import type { AnyEventInput } from './events'

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
        if (path === '/runs/subscribe') return handler.runsSubscribe(request)
      }

      // POST routes
      if (method === 'POST') {
        if (path === '/trigger') return handler.trigger(request)
        if (path === '/retry') return handler.retry(request)
        if (path === '/cancel') return handler.cancel(request)
      }

      return new Response('Not Found', { status: 404 })
    },

    async trigger(request: Request): Promise<Response> {
      try {
        const body = (await request.json()) as TriggerRequest

        if (!body.jobName) {
          return new Response(
            JSON.stringify({ error: 'jobName is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const job = durably.getJob(body.jobName)
        if (!job) {
          return new Response(
            JSON.stringify({ error: `Job not found: ${body.jobName}` }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const run = await job.trigger(body.input ?? {}, {
          idempotencyKey: body.idempotencyKey,
          concurrencyKey: body.concurrencyKey,
        })

        const response: TriggerResponse = { runId: run.id }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    },

    subscribe(request: Request): Response {
      const url = new URL(request.url)
      const runId = url.searchParams.get('runId')

      if (!runId) {
        return new Response(
          JSON.stringify({ error: 'runId query parameter is required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const stream = durably.subscribe(runId)

      // Transform stream to SSE format
      const encoder = new TextEncoder()
      const sseStream = new ReadableStream({
        async start(controller) {
          const reader = stream.getReader()

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) {
                controller.close()
                break
              }

              // Format as SSE
              const event = value as AnyEventInput
              const data = `data: ${JSON.stringify(event)}\n\n`
              controller.enqueue(encoder.encode(data))
            }
          } catch (error) {
            controller.error(error)
          }
        },
      })

      return new Response(sseStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
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

        return new Response(JSON.stringify(runs), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    },

    async run(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = url.searchParams.get('runId')

        if (!runId) {
          return new Response(
            JSON.stringify({ error: 'runId query parameter is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const run = await durably.getRun(runId)

        if (!run) {
          return new Response(JSON.stringify({ error: 'Run not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        return new Response(JSON.stringify(run), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    },

    async retry(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = url.searchParams.get('runId')

        if (!runId) {
          return new Response(
            JSON.stringify({ error: 'runId query parameter is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        await durably.retry(runId)

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    },

    async cancel(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        const runId = url.searchParams.get('runId')

        if (!runId) {
          return new Response(
            JSON.stringify({ error: 'runId query parameter is required' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        await durably.cancel(runId)

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    },

    runsSubscribe(request: Request): Response {
      const url = new URL(request.url)
      const jobNameFilter = url.searchParams.get('jobName')

      const encoder = new TextEncoder()
      let closed = false

      const sseStream = new ReadableStream({
        start(controller) {
          // Subscribe to run lifecycle events
          const unsubscribeTrigger = durably.on('run:trigger', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:trigger',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeStart = durably.on('run:start', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:start',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeComplete = durably.on('run:complete', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:complete',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeFail = durably.on('run:fail', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:fail',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeCancel = durably.on('run:cancel', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:cancel',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeRetry = durably.on('run:retry', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:retry',
              runId: event.runId,
              jobName: event.jobName,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          const unsubscribeProgress = durably.on('run:progress', (event) => {
            if (closed) return
            if (jobNameFilter && event.jobName !== jobNameFilter) return

            const data = `data: ${JSON.stringify({
              type: 'run:progress',
              runId: event.runId,
              jobName: event.jobName,
              progress: event.progress,
            })}\n\n`
            controller.enqueue(encoder.encode(data))
          })

          // Store cleanup function for cancel
          ;(controller as unknown as { cleanup: () => void }).cleanup = () => {
            closed = true
            unsubscribeTrigger()
            unsubscribeStart()
            unsubscribeComplete()
            unsubscribeFail()
            unsubscribeCancel()
            unsubscribeRetry()
            unsubscribeProgress()
          }
        },
        cancel(controller) {
          const cleanup = (controller as unknown as { cleanup: () => void })
            .cleanup
          if (cleanup) cleanup()
        },
      })

      return new Response(sseStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      })
    },
  }

  return handler
}
