/**
 * SSE (Server-Sent Events) utilities for streaming events to clients.
 * Extracted to eliminate duplication between subscribe and runsSubscribe handlers.
 */

import type { Unsubscribe } from './events'

/**
 * SSE response headers
 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const

/**
 * Encode data as SSE format: `data: ${json}\n\n`
 */
function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/**
 * Create a TextEncoder for SSE streams
 */
function createSSEEncoder(): TextEncoder {
  return new TextEncoder()
}

/**
 * Encode and format data for SSE streaming
 */
function encodeSSE(encoder: TextEncoder, data: unknown): Uint8Array {
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
    cancel() {
      reader.releaseLock()
    },
  })
}

/**
 * Transform a ReadableStream of events into an SSE-formatted stream with
 * throttling for `run:progress` events.
 */
export function createThrottledSSEStreamFromReader<T>(
  reader: ReadableStreamDefaultReader<T>,
  throttleMs: number,
): ReadableStream<Uint8Array> {
  if (throttleMs <= 0) {
    return createSSEStreamFromReader(reader)
  }

  const encoder = createSSEEncoder()
  let closed = false
  let throttle: {
    controller: SSEStreamController
    dispose: () => void
  } | null = null

  return new ReadableStream({
    async start(controller) {
      const innerCtrl: SSEStreamController = {
        enqueue: (data: unknown) =>
          controller.enqueue(encodeSSE(encoder, data)),
        close: () => {
          closed = true
          controller.close()
        },
        get closed() {
          return closed
        },
      }
      throttle = createThrottledSSEController(innerCtrl, throttleMs)

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            throttle.controller.close()
            break
          }
          throttle.controller.enqueue(value)
        }
      } catch (error) {
        throttle.dispose()
        reader.releaseLock()
        controller.error(error)
      }
    },
    cancel() {
      closed = true
      throttle?.dispose()
      reader.releaseLock()
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

const TERMINAL_EVENT_TYPES = new Set([
  'run:complete',
  'run:fail',
  'run:cancel',
  'run:delete',
])

/**
 * Create an SSE stream controller that throttles `run:progress` events.
 *
 * - First progress event per run is delivered immediately
 * - Subsequent events within the throttle window are coalesced (latest wins)
 * - A trailing flush ensures the last progress is always delivered
 * - Non-progress events pass through immediately
 */
export function createThrottledSSEController(
  inner: SSEStreamController,
  throttleMs: number,
): { controller: SSEStreamController; dispose: () => void } {
  if (throttleMs <= 0) {
    return { controller: inner, dispose: () => {} }
  }

  // Per-run throttle state
  const pending = new Map<
    string,
    { data: unknown; timer: ReturnType<typeof setTimeout> }
  >()

  // Track last send time per run for leading-edge delivery
  const lastSent = new Map<string, number>()

  const controller: SSEStreamController = {
    enqueue(data: unknown) {
      if (inner.closed) return

      const event =
        typeof data === 'object' && data !== null
          ? (data as { type?: string; runId?: string })
          : null

      // Flush and clean up throttle state for terminal run events
      if (event?.runId && TERMINAL_EVENT_TYPES.has(event.type ?? '')) {
        lastSent.delete(event.runId)
        const entry = pending.get(event.runId)
        if (entry) {
          clearTimeout(entry.timer)
          if (!inner.closed) inner.enqueue(entry.data)
          pending.delete(event.runId)
        }
      }

      if (event?.type !== 'run:progress' || !event?.runId) {
        inner.enqueue(data)
        return
      }

      const runId = event.runId
      const now = Date.now()
      const last = lastSent.get(runId) ?? 0

      // Leading edge: send immediately if enough time has passed
      if (now - last >= throttleMs) {
        lastSent.set(runId, now)
        // Clear any pending flush for this run
        const entry = pending.get(runId)
        if (entry) {
          clearTimeout(entry.timer)
          pending.delete(runId)
        }
        inner.enqueue(data)
        return
      }

      // Trailing edge: buffer latest and schedule flush
      const existing = pending.get(runId)
      if (existing) {
        clearTimeout(existing.timer)
      }

      const delay = Math.max(0, throttleMs - (now - last))
      const timer = setTimeout(() => {
        const current = pending.get(runId)
        if (!current || current.timer !== timer) return

        pending.delete(runId)
        if (!inner.closed) {
          lastSent.set(runId, Date.now())
          inner.enqueue(current.data)
        }
      }, delay)

      pending.set(runId, { data, timer })
    },
    close() {
      // Flush all pending progress events before closing
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        if (!inner.closed) {
          inner.enqueue(entry.data)
        }
      }
      pending.clear()
      lastSent.clear()
      inner.close()
    },
    get closed() {
      return inner.closed
    },
  }

  const dispose = () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
    }
    pending.clear()
    lastSent.clear()
  }

  return { controller, dispose }
}
