/**
 * Client mode useRunActions tests
 *
 * Test retrigger and cancel actions via fetch
 */

import { act, renderHook } from '@testing-library/react'
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

    it('sets isLoadingFor only for that run during request', async () => {
      let resolvePromise: () => void
      const fetchPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve
      })
      const fetchMock = vi.fn().mockImplementation(() =>
        fetchPromise.then(() => ({
          ok: true,
          json: () => Promise.resolve({ success: true, runId: 'new-run-789' }),
        })),
      )
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      expect(result.current.isLoadingFor('run-A')).toBe(false)
      expect(result.current.isLoadingFor('run-B')).toBe(false)

      let retriggerPromise: Promise<string>
      act(() => {
        retriggerPromise = result.current.retrigger('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(true)
      expect(result.current.isLoadingFor('run-B')).toBe(false)

      await act(async () => {
        resolvePromise!()
        await retriggerPromise
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
    })

    it('sets error on failure and throws', async () => {
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
      expect(result.current.error).toBe('Run not found')
      expect(result.current.isLoadingFor('run-123')).toBe(false)
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
      expect(result.current.error).toBe(
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
      expect(result.current.error).toBe(
        'Failed to retrigger: Internal Server Error',
      )
    })

    it('clears error on new request', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          statusText: 'Error',
          json: () => Promise.resolve({ error: 'First error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ success: true, runId: 'new-run-999' }),
        })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      // First call fails
      await act(async () => {
        try {
          await result.current.retrigger('run-123')
        } catch {
          // Expected
        }
      })

      expect(result.current.error).toBe('First error')

      // Second call succeeds
      await act(async () => {
        await result.current.retrigger('run-123')
      })

      expect(result.current.error).toBeNull()
    })

    it('clears isLoadingFor after success', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, runId: 'new-id' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.retrigger('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
    })

    it('clears isLoadingFor on error', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ error: 'bad' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        try {
          await result.current.retrigger('run-A')
        } catch {
          // expected
        }
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
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

    it('sets isLoadingFor only for that run during request', async () => {
      let resolvePromise: () => void
      const fetchPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve
      })
      const fetchMock = vi.fn().mockImplementation(() =>
        fetchPromise.then(() => ({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })),
      )
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      expect(result.current.isLoadingFor('run-A')).toBe(false)

      let cancelPromise: Promise<void>
      act(() => {
        cancelPromise = result.current.cancel('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(true)
      expect(result.current.isLoadingFor('run-B')).toBe(false)

      await act(async () => {
        resolvePromise!()
        await cancelPromise
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
    })

    it('sets error on failure and throws', async () => {
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
      expect(result.current.error).toBe('Run already completed')
      expect(result.current.isLoadingFor('run-456')).toBe(false)
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
          await result.current.cancel('run-456')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe(
        'Failed to cancel: Internal Server Error',
      )
      expect(result.current.error).toBe(
        'Failed to cancel: Internal Server Error',
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
          await result.current.cancel('run-456')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe(
        'Failed to cancel: Internal Server Error',
      )
      expect(result.current.error).toBe(
        'Failed to cancel: Internal Server Error',
      )
    })
  })

  describe('deleteRun', () => {
    it('calls DELETE on run URL with runId', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.deleteRun('run-del')
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/durably/run?runId=run-del', {
        method: 'DELETE',
      })
    })

    it('sets isLoadingFor during delete', async () => {
      let resolvePromise: () => void
      const fetchPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve
      })
      const fetchMock = vi.fn().mockImplementation(() =>
        fetchPromise.then(() => ({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        })),
      )
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let p: Promise<void>
      act(() => {
        p = result.current.deleteRun('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(true)

      await act(async () => {
        resolvePromise!()
        await p
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
    })

    it('sets error and clears isLoadingFor on failure', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Forbidden',
        json: () => Promise.resolve({ error: 'cannot delete' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        try {
          await result.current.deleteRun('run-x')
        } catch {
          // expected
        }
      })

      expect(result.current.error).toBe('cannot delete')
      expect(result.current.isLoadingFor('run-x')).toBe(false)
    })
  })

  describe('getRun and getSteps', () => {
    it('does not set isLoadingFor while getRun is pending', async () => {
      let resolveFetch: () => void
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                id: 'run-A',
                jobName: 'j',
                status: 'completed',
                input: {},
                output: null,
                labels: {},
                createdAt: '',
                currentStepIndex: 0,
                completedStepCount: 0,
              }),
          } as Response)
      })

      const fetchMock = vi.fn().mockImplementation(() => pending)
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let getRunPromise: Promise<unknown>
      act(() => {
        getRunPromise = result.current.getRun('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)

      await act(async () => {
        resolveFetch!()
        await getRunPromise
      })
    })

    it('does not set isLoadingFor while getSteps is pending', async () => {
      let resolveFetch: () => void
      const pending = new Promise<Response>((resolve) => {
        resolveFetch = () =>
          resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve([]),
          } as Response)
      })

      const fetchMock = vi.fn().mockImplementation(() => pending)
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let getStepsPromise: Promise<unknown>
      act(() => {
        getStepsPromise = result.current.getSteps('run-A')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)

      await act(async () => {
        resolveFetch!()
        await getStepsPromise
      })
    })
  })

  describe('concurrent actions', () => {
    it('tracks two runs independently', async () => {
      let resolveRetrigger: () => void
      let resolveCancel: () => void
      const pRetrigger = new Promise<void>((r) => {
        resolveRetrigger = r
      })
      const pCancel = new Promise<void>((r) => {
        resolveCancel = r
      })

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/retrigger')) {
          return pRetrigger.then(() => ({
            ok: true,
            json: () => Promise.resolve({ success: true, runId: 'new-from-a' }),
          }))
        }
        if (url.includes('/cancel')) {
          return pCancel.then(() => ({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          }))
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
        })
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      let p1: Promise<string>
      let p2: Promise<void>
      act(() => {
        p1 = result.current.retrigger('run-A')
        p2 = result.current.cancel('run-B')
      })

      expect(result.current.isLoadingFor('run-A')).toBe(true)
      expect(result.current.isLoadingFor('run-B')).toBe(true)

      await act(async () => {
        resolveRetrigger!()
        await p1
      })

      expect(result.current.isLoadingFor('run-A')).toBe(false)
      expect(result.current.isLoadingFor('run-B')).toBe(true)

      await act(async () => {
        resolveCancel!()
        await p2
      })

      expect(result.current.isLoadingFor('run-B')).toBe(false)
    })
  })
})
