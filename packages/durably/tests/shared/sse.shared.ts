import { describe, expect, it, vi } from 'vitest'
import {
  createSSEResponse,
  createSSEStreamFromReader,
  createSSEStreamFromSubscriptions,
} from '../../src/sse'

export function createSSETests(): void {
  describe('SSE Utilities', () => {
    describe('createSSEResponse', () => {
      it('creates a response with correct SSE headers', () => {
        const stream = new ReadableStream()
        const response = createSSEResponse(stream)

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
        expect(response.headers.get('Cache-Control')).toBe('no-cache')
        expect(response.headers.get('Connection')).toBe('keep-alive')
      })
    })

    describe('createSSEStreamFromReader', () => {
      it('transforms stream data to SSE format', async () => {
        const data = [{ type: 'test', value: 1 }, { type: 'test', value: 2 }]
        const readable = new ReadableStream({
          start(controller) {
            for (const item of data) {
              controller.enqueue(item)
            }
            controller.close()
          },
        })

        const sseStream = createSSEStreamFromReader(readable.getReader())
        const reader = sseStream.getReader()
        const decoder = new TextDecoder()

        const chunks: string[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(decoder.decode(value))
        }

        expect(chunks).toHaveLength(2)
        expect(chunks[0]).toBe('data: {"type":"test","value":1}\n\n')
        expect(chunks[1]).toBe('data: {"type":"test","value":2}\n\n')
      })

      it('releases reader lock on cancel', async () => {
        const readable = new ReadableStream({
          start() {
            // Don't close - simulate long-running stream
          },
        })

        const reader = readable.getReader()
        const sseStream = createSSEStreamFromReader(reader)

        // Cancel the SSE stream - this should release the reader lock
        await sseStream.cancel()

        // Should be able to get a new reader (lock was released)
        const newReader = readable.getReader()
        expect(newReader).toBeDefined()
        newReader.releaseLock()
      })

      it('handles errors from source stream', async () => {
        const error = new Error('Source stream error')
        const readable = new ReadableStream({
          start(controller) {
            controller.error(error)
          },
        })

        const sseStream = createSSEStreamFromReader(readable.getReader())
        const reader = sseStream.getReader()

        await expect(reader.read()).rejects.toThrow('Source stream error')
      })
    })

    describe('createSSEStreamFromSubscriptions', () => {
      it('calls setup function with controller', async () => {
        const setup = vi.fn().mockReturnValue([])

        const stream = createSSEStreamFromSubscriptions(setup)
        const reader = stream.getReader()

        // Give it time to initialize
        await new Promise((r) => setTimeout(r, 10))

        expect(setup).toHaveBeenCalledTimes(1)
        expect(setup).toHaveBeenCalledWith(
          expect.objectContaining({
            enqueue: expect.any(Function),
            close: expect.any(Function),
            closed: false,
          }),
        )

        // Cancel via reader to properly cleanup
        await reader.cancel()
      })

      it('enqueues data in SSE format', async () => {
        const stream = createSSEStreamFromSubscriptions((controller) => {
          controller.enqueue({ type: 'event', data: 'hello' })
          controller.close()
          return []
        })

        const reader = stream.getReader()
        const decoder = new TextDecoder()

        const { value, done } = await reader.read()
        expect(done).toBe(false)
        expect(decoder.decode(value)).toBe(
          'data: {"type":"event","data":"hello"}\n\n',
        )

        const { done: done2 } = await reader.read()
        expect(done2).toBe(true)
      })

      it('calls unsubscribe functions on cancel', async () => {
        const unsubscribe1 = vi.fn()
        const unsubscribe2 = vi.fn()

        const stream = createSSEStreamFromSubscriptions(() => {
          return [unsubscribe1, unsubscribe2]
        })

        const reader = stream.getReader()
        // Start reading to trigger setup
        await new Promise((r) => setTimeout(r, 10))

        // Cancel via reader (which internally cancels the stream)
        await reader.cancel()

        expect(unsubscribe1).toHaveBeenCalledTimes(1)
        expect(unsubscribe2).toHaveBeenCalledTimes(1)
      })

      it('ignores enqueue after close', async () => {
        let capturedController: {
          enqueue: (data: unknown) => void
          close: () => void
          closed: boolean
        } | null = null

        const stream = createSSEStreamFromSubscriptions((controller) => {
          capturedController = controller
          controller.enqueue({ first: true })
          controller.close()
          return []
        })

        const reader = stream.getReader()
        const decoder = new TextDecoder()

        // Read first event
        const { value } = await reader.read()
        expect(decoder.decode(value)).toContain('"first":true')

        // Stream should be closed
        const { done } = await reader.read()
        expect(done).toBe(true)

        // Controller should show closed state
        expect(capturedController?.closed).toBe(true)

        // Enqueue after close should be ignored (no error)
        expect(() => capturedController?.enqueue({ ignored: true })).not.toThrow()
      })
    })
  })
}
