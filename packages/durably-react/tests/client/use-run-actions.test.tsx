/**
 * Client mode useRunActions tests
 *
 * Test retrigger and cancel actions via fetch
 */

import { act, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRunActions } from '../../src/client/use-run-actions'

describe('useRunActions (client)', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('retrigger', () => {
    it('calls retrigger endpoint with runId and returns new runId', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, runId: 'new-run-123' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let nextRunId: string | undefined
      await act(async () => {
        nextRunId = await result.current.retrigger('run-123')
      })

      expect(nextRunId).toBe('new-run-123')
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/retrigger?runId=run-123',
        { method: 'POST' },
      )
    })

    it('encodes runId in URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, runId: 'new-run-456' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.retrigger('run/with/special&chars')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/retrigger?runId=run%2Fwith%2Fspecial%26chars',
        { method: 'POST' },
      )
    })

    it('throws on failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'Run not found' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let thrownError: Error | undefined
      await act(async () => {
        try {
          await result.current.retrigger('run-123')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe('Run not found')
    })

    it('uses statusText when no error in response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
        json: () => Promise.resolve({}),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let thrownError: Error | undefined
      await act(async () => {
        try {
          await result.current.retrigger('run-123')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe(
        'Failed to retrigger: Internal Server Error',
      )
    })

    it('handles non-JSON error response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('Invalid JSON')),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let thrownError: Error | undefined
      await act(async () => {
        try {
          await result.current.retrigger('run-123')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe(
        'Failed to retrigger: Internal Server Error',
      )
    })
  })

  describe('cancel', () => {
    it('calls cancel endpoint with runId', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.cancel('run-456')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/cancel?runId=run-456',
        { method: 'POST' },
      )
    })

    it('encodes runId in URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.cancel('run/with/special&chars')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/cancel?runId=run%2Fwith%2Fspecial%26chars',
        { method: 'POST' },
      )
    })

    it('throws on failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'Run already completed' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let thrownError: Error | undefined
      await act(async () => {
        try {
          await result.current.cancel('run-456')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe('Run already completed')
    })
  })

  describe('result shape', () => {
    it('exposes only action methods', () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      expect(Object.keys(result.current).sort()).toEqual([
        'cancel',
        'deleteRun',
        'getRun',
        'getSteps',
        'retrigger',
      ])
    })
  })

  describe('local rejection handling', () => {
    it('does not surface an unhandled rejection when the caller catches', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
        json: () => Promise.resolve({ error: 'Run not found' }),
      })
      globalThis.fetch = fetchMock

      const unhandled: unknown[] = []
      const onUnhandled = (e: PromiseRejectionEvent) => {
        unhandled.push(e.reason)
        e.preventDefault()
      }
      globalThis.addEventListener('unhandledrejection', onUnhandled)

      function Harness() {
        const { retrigger } = useRunActions({ api: '/api/durably' })
        return (
          <button
            type="button"
            onClick={() => {
              void retrigger('run-123').catch(() => {})
            }}
          >
            go
          </button>
        )
      }

      const { getByRole } = render(<Harness />)

      await act(async () => {
        getByRole('button').click()
        await Promise.resolve()
      })

      globalThis.removeEventListener('unhandledrejection', onUnhandled)

      expect(unhandled).toHaveLength(0)
    })
  })
})
