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
 * Handler interface for HTTP endpoints
 */
export interface DurablyHandler {
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
}

/**
 * Create HTTP handlers for Durably
 * Uses Web Standard Request/Response for framework-agnostic usage
 */
export function createDurablyHandler(durably: Durably): DurablyHandler {
  return {
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
  }
}
