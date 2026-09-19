import compression from 'compression'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createSSEResponse } from '../../src/sse'

it('delivers an SSE event through compression while the stream remains open', async () => {
  const middleware = compression({ threshold: 0 })
  const event = 'data: {"status":"leased"}\n\n'
  const server = createServer((request, response) => {
    middleware(
      request as Parameters<typeof middleware>[0],
      response as Parameters<typeof middleware>[1],
      () => {
        const sse = createSSEResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(event))
              // Keep the stream open: compression must not wait for its end.
            },
          }),
        )
        for (const [name, value] of sse.headers) response.setHeader(name, value)
        const reader = sse.body!.getReader()
        response.on('close', () => {
          void reader.cancel().catch(() => {})
        })
        const pipe = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              response.write(value)
            }
            response.end()
          } finally {
            reader.releaseLock()
          }
        }
        void pipe().catch((error: Error) => response.destroy(error))
      },
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No TCP port')
    const response = await fetch(`http://127.0.0.1:${address.port}`, {
      headers: { 'Accept-Encoding': 'gzip' },
      signal: AbortSignal.timeout(2000),
    })
    const reader = response.body!.getReader()
    try {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      expect(new TextDecoder().decode(value)).toBe(event)
    } finally {
      await reader.cancel()
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
