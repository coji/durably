/**
 * Client mode useJob tests
 *
 * Test trigger via fetch and SSE subscription
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJob } from '../../src/client/use-job'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

describe('useJob (client)', () => {
  let mockEventSource: MockEventSourceConstructor
  let originalEventSource: typeof EventSource
  let originalFetch: typeof fetch

  beforeEach(() => {
    mockEventSource = createMockEventSource()
    originalEventSource = globalThis.EventSource
    originalFetch = globalThis.fetch
    globalThis.EventSource = mockEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('triggers via fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'test-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    const { runId } = await result.current.trigger({ input: 'test' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ jobName: 'test-job', input: { input: 'test' } }),
      }),
    )
    expect(runId).toBe('test-run-id')
  })

  it('subscribes via EventSource after trigger', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'sse-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    // Wait for EventSource to be created
    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    // Emit run:start event
    act(() => {
      mockEventSource.emit({ type: 'run:start', runId: 'sse-run-id' })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('running')
    })
  })

  it('updates status on run:complete', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'complete-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob<{ input: string }, { result: string }>({
        api: '/api/durably',
        jobName: 'test-job',
      }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'complete-run-id',
        output: { result: 'done' },
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('completed')
      expect(result.current.output).toEqual({ result: 'done' })
      expect(result.current.isCompleted).toBe(true)
    })
  })

  it('updates status on run:fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'fail-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:fail',
        runId: 'fail-run-id',
        error: 'Something went wrong',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('Something went wrong')
      expect(result.current.isFailed).toBe(true)
    })
  })

  it('handles progress events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'progress-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:progress',
        runId: 'progress-run-id',
        progress: { current: 1, total: 3 },
      })
    })

    await waitFor(() => {
      expect(result.current.progress).toEqual({ current: 1, total: 3 })
    })
  })

  it('handles log events', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'log-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'log-run-id',
        level: 'info',
        message: 'Processing',
        data: null,
      })
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1)
      expect(result.current.logs[0].message).toBe('Processing')
    })
  })

  it('handles connection errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'error-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.triggerError(new Error('Connection failed'))
    })

    await waitFor(() => {
      expect(result.current.error).toBe('Connection failed')
    })
  })

  it('reset clears all state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'reset-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'reset-run-id',
        output: { result: 'done' },
      })
    })

    await waitFor(() => {
      expect(result.current.isCompleted).toBe(true)
    })

    act(() => {
      result.current.reset()
    })

    expect(result.current.status).toBeNull()
    expect(result.current.output).toBeNull()
    expect(result.current.currentRunId).toBeNull()
  })

  it('provides currentRunId after trigger', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'current-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    expect(result.current.currentRunId).toBeNull()

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.currentRunId).toBe('current-run-id')
    })
  })

  it('throws on fetch error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Job not found'),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'unknown-job' }),
    )

    await expect(result.current.trigger({ input: 'test' })).rejects.toThrow(
      'Job not found',
    )
  })

  it('throws on fetch error with empty text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve(''),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' }),
    )

    await expect(result.current.trigger({ input: 'test' })).rejects.toThrow(
      'HTTP 500',
    )
  })

  // Note: triggerAndWait tests are difficult to test with the polling-based implementation
  // because the hook needs to re-render to see the updated subscription.status.
  // The triggerAndWait function is covered by the browser tests which use real React re-renders.

  describe('initialRunId', () => {
    it('sets currentRunId from initialRunId', () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'existing-run-id',
        }),
      )

      expect(result.current.currentRunId).toBe('existing-run-id')
    })

    it('subscribes to initialRunId via EventSource immediately', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'existing-run-id',
        }),
      )

      // EventSource should be created for the initial run
      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      expect(mockEventSource.instances[0].url).toContain('existing-run-id')
    })

    it('receives events for initialRunId', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob<{ input: string }, { result: string }>({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'existing-run-id',
        }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      // Simulate receiving events for the existing run
      act(() => {
        mockEventSource.emit({
          type: 'run:progress',
          runId: 'existing-run-id',
          progress: { current: 5, total: 10, message: 'In progress' },
        })
      })

      await waitFor(() => {
        expect(result.current.progress).toEqual({
          current: 5,
          total: 10,
          message: 'In progress',
        })
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:complete',
          runId: 'existing-run-id',
          output: { result: 'reconnected' },
        })
      })

      await waitFor(() => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ result: 'reconnected' })
        expect(result.current.isCompleted).toBe(true)
      })
    })

    it('can trigger new run after initialRunId', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: 'new-run-id' }),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'existing-run-id',
        }),
      )

      expect(result.current.currentRunId).toBe('existing-run-id')

      // Trigger a new run
      await result.current.trigger({ input: 'new' })

      await waitFor(() => {
        expect(result.current.currentRunId).toBe('new-run-id')
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/trigger',
        expect.objectContaining({
          method: 'POST',
        }),
      )
    })
  })
})
