/**
 * Client mode useRunActions tests
 *
 * Test retry and cancel actions via fetch
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

  describe('retry', () => {
    it('calls retry endpoint with runId', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      await act(async () => {
        await result.current.retry('run-123')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/retry?runId=run-123',
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
        await result.current.retry('run/with/special&chars')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/retry?runId=run%2Fwith%2Fspecial%26chars',
        { method: 'POST' },
      )
    })

    it('sets isLoading during request', async () => {
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

      expect(result.current.isLoading).toBe(false)

      let retryPromise: Promise<void>
      act(() => {
        retryPromise = result.current.retry('run-123')
      })

      expect(result.current.isLoading).toBe(true)

      await act(async () => {
        resolvePromise!()
        await retryPromise
      })

      expect(result.current.isLoading).toBe(false)
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
          await result.current.retry('run-123')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe('Run not found')
      expect(result.current.error).toBe('Run not found')
      expect(result.current.isLoading).toBe(false)
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
          await result.current.retry('run-123')
        } catch (err) {
          thrownError = err as Error
        }
      })

      expect(thrownError?.message).toBe(
        'Failed to retry: Internal Server Error',
      )
      expect(result.current.error).toBe(
        'Failed to retry: Internal Server Error',
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
          json: () => Promise.resolve({ success: true }),
        })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useRunActions({ api: '/api/durably' }),
      )

      // First call fails
      await act(async () => {
        try {
          await result.current.retry('run-123')
        } catch {
          // Expected
        }
      })

      expect(result.current.error).toBe('First error')

      // Second call succeeds
      await act(async () => {
        await result.current.retry('run-123')
      })

      expect(result.current.error).toBeNull()
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

    it('sets isLoading during request', async () => {
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

      expect(result.current.isLoading).toBe(false)

      let cancelPromise: Promise<void>
      act(() => {
        cancelPromise = result.current.cancel('run-456')
      })

      expect(result.current.isLoading).toBe(true)

      await act(async () => {
        resolvePromise!()
        await cancelPromise
      })

      expect(result.current.isLoading).toBe(false)
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
      expect(result.current.isLoading).toBe(false)
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
  })

  describe('shared state', () => {
    it('shares isLoading between retry and cancel', async () => {
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

      let retryPromise: Promise<void>
      act(() => {
        retryPromise = result.current.retry('run-123')
      })

      expect(result.current.isLoading).toBe(true)

      await act(async () => {
        resolvePromise!()
        await retryPromise
      })

      expect(result.current.isLoading).toBe(false)
    })
  })
})
