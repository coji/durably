/**
 * SSE (Server-Sent Events) utilities for streaming events to clients.
 * Extracted to eliminate duplication between subscribe and runsSubscribe handlers.
 */

/**
 * SSE response headers
 */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const

/**
 * Encode data as SSE format: `data: ${json}\n\n`
 */
export function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/**
 * Create a TextEncoder for SSE streams (shared instance pattern)
 */
export function createSSEEncoder(): TextEncoder {
  return new TextEncoder()
}

/**
 * Encode and format data for SSE streaming
 */
export function encodeSSE(encoder: TextEncoder, data: unknown): Uint8Array {
  return encoder.encode(formatSSE(data))
}

/**
 * Create an SSE Response from a ReadableStream
 */
export function createSSEResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    status: 200,
    headers: SSE_HEADERS,
  })
}

/**
 * Transform a ReadableStream of events into an SSE-formatted stream
 */
export function createSSEStreamFromReader<T>(
  reader: ReadableStreamDefaultReader<T>,
): ReadableStream<Uint8Array> {
  const encoder = createSSEEncoder()

  return new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            break
          }

          controller.enqueue(encodeSSE(encoder, value))
        }
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/**
 * SSE stream controller with cleanup support
 */
export interface SSEStreamController {
  enqueue: (data: unknown) => void
  close: () => void
  readonly closed: boolean
}

/**
 * Cleanup function type for unsubscribing
 */
export type Unsubscribe = () => void

/**
 * Create an SSE stream from event subscriptions.
 * Handles the common pattern of subscribing to multiple events and streaming them.
 *
 * @param setup - Function to set up event subscriptions, returns cleanup functions
 * @returns SSE Response
 */
export function createSSEStreamFromSubscriptions(
  setup: (controller: SSEStreamController) => Unsubscribe[],
): ReadableStream<Uint8Array> {
  const encoder = createSSEEncoder()
  let closed = false
  let unsubscribes: Unsubscribe[] = []

  return new ReadableStream({
    start(controller) {
      const sseController: SSEStreamController = {
        enqueue: (data: unknown) => {
          if (closed) return
          controller.enqueue(encodeSSE(encoder, data))
        },
        close: () => {
          if (closed) return
          closed = true
          controller.close()
        },
        get closed() {
          return closed
        },
      }

      unsubscribes = setup(sseController)
    },
    cancel() {
      closed = true
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    },
  })
}
