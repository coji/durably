/**
 * Client mode useJob tests
 *
 * Test trigger via fetch and SSE subscription
 */

import { act, render, renderHook, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
    )

    await result.current.trigger({ input: 'test' })

    // Wait for EventSource to be created
    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    // Emit run:leased event
    act(() => {
      mockEventSource.emit({ type: 'run:leased', runId: 'sse-run-id' })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('leased')
      expect(result.current.isTerminal).toBe(false)
      expect(result.current.isActive).toBe(true)
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
        autoResume: false,
        followLatest: false,
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
      expect(result.current.isTerminal).toBe(true)
      expect(result.current.isActive).toBe(false)
    })
  })

  it('updates status on run:fail', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'fail-run-id' }),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'unknown-job',
        autoResume: false,
        followLatest: false,
      }),
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
      useJob({
        api: '/api/durably',
        jobName: 'test-job',
        autoResume: false,
        followLatest: false,
      }),
    )

    await expect(result.current.trigger({ input: 'test' })).rejects.toThrow(
      'HTTP 500',
    )
  })

  describe('initialRunId', () => {
    it('sets currentRunId from initialRunId', () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'existing-run-id',
          followLatest: false,
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
          followLatest: false,
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
          followLatest: false,
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
          followLatest: false,
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

  describe('autoResume', () => {
    it('fetches leased job on mount and subscribes (autoResume: true by default)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([{ id: 'leased-job-id', status: 'leased' }]),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )

      // Should fetch runs with status=leased (with AbortController signal)
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining('/api/durably/runs?'),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        )
      })

      // Should set currentRunId to the leased job
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('leased-job-id')
      })
    })

    it('fetches pending job if no leased job found', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]), // No leased jobs
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve([{ id: 'pending-job-id', status: 'pending' }]),
        })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )

      // Should set currentRunId to the pending job
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('pending-job-id')
      })
    })

    it('does not fetch runs when autoResume: false', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          autoResume: false,
        }),
      )

      // Advance time to ensure no fetch happens
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })

      expect(fetchMock).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('skips autoResume when initialRunId is provided', async () => {
      vi.useFakeTimers()
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          initialRunId: 'explicit-run-id',
        }),
      )

      // Advance time to ensure no fetch happens
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })

      // Should not fetch runs because initialRunId is provided
      expect(fetchMock).not.toHaveBeenCalled()

      // Should use the provided initialRunId
      expect(result.current.currentRunId).toBe('explicit-run-id')
      vi.useRealTimers()
    })
  })

  describe('followLatest', () => {
    it('switches to new run on run:trigger event (followLatest: true by default)', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]), // No existing runs
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
        }),
      )

      // Wait for job-level SSE to be created
      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      // Simulate a new run being triggered (from another tab/client)
      act(() => {
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'new-run-from-elsewhere',
          jobName: 'test-job',
        })
      })

      await waitFor(() => {
        expect(result.current.currentRunId).toBe('new-run-from-elsewhere')
      })
    })

    it('switches to new run on run:leased event', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
        }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:leased',
          runId: 'started-run-id',
          jobName: 'test-job',
        })
      })

      await waitFor(() => {
        expect(result.current.currentRunId).toBe('started-run-id')
      })
    })

    it('does not switch to new run when followLatest: false', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ id: 'current-run-id', status: 'leased' }]),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )

      // Wait for autoResume to set currentRunId
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('current-run-id')
      })

      // Simulate a new run being triggered via run-level subscription (not job-level)
      // When followLatest is false, there's no job-level SSE subscription
      act(() => {
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'new-run-id',
          jobName: 'test-job',
        })
      })

      // The run-level event should not change the currentRunId
      // because followLatest: false means no job-level SSE subscription
      expect(result.current.currentRunId).toBe('current-run-id')
    })
  })

  describe('scoped tracking', () => {
    it('adds every scope label to both active lookups and the job subscription', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          scope: { labels: { documentId: 'doc/1', tenant: 'acme' } },
        }),
      )

      expect(result.current.isResolving).toBe(true)
      await waitFor(() => expect(result.current.isResolving).toBe(false))

      const lookupUrls = fetchMock.mock.calls.map(([url]) => String(url))
      expect(lookupUrls).toHaveLength(2)
      for (const url of lookupUrls) {
        const parsed = new URL(url, 'http://example.test')
        expect(parsed.searchParams.get('label.documentId')).toBe('doc/1')
        expect(parsed.searchParams.get('label.tenant')).toBe('acme')
      }
      const jobSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('jobName=test-job'),
      )
      expect(jobSubscription).toBeDefined()
      const subscriptionUrl = new URL(
        jobSubscription!.url,
        'http://example.test',
      )
      expect(subscriptionUrl.searchParams.get('label.documentId')).toBe('doc/1')
      expect(subscriptionUrl.searchParams.get('label.tenant')).toBe('acme')
    })

    it('hydrates leased and coalesced follow events with their immediate status', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      const { result } = renderHook(() =>
        useJob({ api: '/api/durably', jobName: 'test-job' }),
      )
      await waitFor(() =>
        expect(mockEventSource.instances.length).toBeGreaterThan(0),
      )
      const jobSubscription = mockEventSource.instances[0]

      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:coalesced',
              runId: 'coalesced-leased',
              jobName: 'test-job',
              status: 'leased',
            }),
          }),
        )
      })
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('coalesced-leased')
        expect(result.current.status).toBe('leased')
      })

      const runSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('runId=coalesced-leased'),
      )
      expect(runSubscription).toBeDefined()
      act(() => {
        runSubscription!.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:leased',
              runId: 'coalesced-leased',
            }),
          }),
        )
        runSubscription!.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:progress',
              runId: 'coalesced-leased',
              progress: { current: 1, total: 2 },
            }),
          }),
        )
      })
      expect(result.current.progress).toEqual({ current: 1, total: 2 })

      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:coalesced',
              runId: 'coalesced-leased',
              jobName: 'test-job',
              status: 'pending',
            }),
          }),
        )
      })
      expect(result.current.status).toBe('pending')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })

      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:trigger',
              runId: 'new-pending',
              jobName: 'test-job',
            }),
          }),
        )
      })
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('new-pending')
        expect(result.current.status).toBe('pending')
      })
    })

    it('does not regress a completed run after a late coalesced event', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      const { result } = renderHook(() =>
        useJob({ api: '/api/durably', jobName: 'test-job' }),
      )
      const jobSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('jobName=test-job'),
      )!

      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:coalesced',
              runId: 'same-run',
              status: 'leased',
            }),
          }),
        )
      })
      await waitFor(() => expect(result.current.status).toBe('leased'))
      const runSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('runId=same-run'),
      )!

      act(() => {
        runSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:complete',
              runId: 'same-run',
              output: { success: true },
            }),
          }),
        )
      })
      expect(result.current.status).toBe('completed')

      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:coalesced',
              runId: 'same-run',
              status: 'leased',
            }),
          }),
        )
      })
      expect(result.current.status).toBe('completed')
      expect(result.current.output).toEqual({ success: true })
    })

    it('ignores an old trigger response after its scope changes', async () => {
      let resolveFetch!: (value: {
        ok: boolean
        json: () => Promise<unknown>
      }) => void
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve
          }),
      )
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume: false,
            followLatest: false,
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'old' } },
      )

      const pending = result.current.trigger({ input: 'test' })
      rerender({ documentId: 'new' })
      await act(async () => {
        resolveFetch({
          ok: true,
          json: () => Promise.resolve({ runId: 'old-run', status: 'pending' }),
        })
      })
      await expect(pending).resolves.toEqual({ runId: 'old-run' })
      expect(result.current.currentRunId).toBeNull()
      expect(result.current.status).toBeNull()
    })

    it('clears resolving when reset supersedes an in-flight lookup', async () => {
      const resolvers: Array<
        (value: { ok: boolean; json: () => Promise<unknown> }) => void
      > = []
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const { result } = renderHook(() =>
        useJob({ api: '/api/durably', jobName: 'test-job' }),
      )
      await waitFor(() => expect(resolvers).toHaveLength(1))
      expect(result.current.isResolving).toBe(true)

      act(() => result.current.reset())
      expect(result.current.isResolving).toBe(false)
      await act(async () => {
        for (const resolve of resolvers) {
          resolve({ ok: true, json: () => Promise.resolve([]) })
        }
      })
      expect(result.current.isResolving).toBe(false)
    })

    it('marks a lookup as resolving when autoResume is enabled later', async () => {
      const resolvers: Array<
        (value: { ok: boolean; json: () => Promise<unknown> }) => void
      > = []
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const { result, rerender } = renderHook(
        ({ autoResume }: { autoResume: boolean }) =>
          useJob({ api: '/api/durably', jobName: 'test-job', autoResume }),
        { initialProps: { autoResume: false } },
      )
      expect(result.current.isResolving).toBe(false)
      rerender({ autoResume: true })
      await waitFor(() => expect(resolvers).toHaveLength(1))
      expect(result.current.isResolving).toBe(true)

      await act(async () => {
        resolvers[0]({ ok: true, json: () => Promise.resolve([]) })
      })
      await waitFor(() => expect(resolvers).toHaveLength(2))
      await act(async () => {
        resolvers[1]({ ok: true, json: () => Promise.resolve([]) })
      })
      await waitFor(() => expect(result.current.isResolving).toBe(false))
    })

    it('resolves again when initialRunId is removed', async () => {
      const resolvers: Array<
        (value: { ok: boolean; json: () => Promise<unknown> }) => void
      > = []
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const { result, rerender } = renderHook(
        ({ initialRunId }: { initialRunId?: string }) =>
          useJob({ api: '/api/durably', jobName: 'test-job', initialRunId }),
        { initialProps: { initialRunId: 'explicit' as string | undefined } },
      )
      expect(result.current.currentRunId).toBe('explicit')
      expect(result.current.isResolving).toBe(false)

      rerender({ initialRunId: undefined })
      await waitFor(() => expect(resolvers).toHaveLength(1))
      expect(result.current.currentRunId).toBeNull()
      expect(result.current.isResolving).toBe(true)

      await act(async () => {
        resolvers[0]({ ok: true, json: () => Promise.resolve([]) })
      })
      await waitFor(() => expect(resolvers).toHaveLength(2))
      await act(async () => {
        resolvers[1]({ ok: true, json: () => Promise.resolve([]) })
      })
      await waitFor(() => expect(result.current.isResolving).toBe(false))
    })

    it('auto-resumes after an explicit run is removed following a user trigger', async () => {
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return {
            ok: true,
            json: () => Promise.resolve({ runId: 'user-run' }),
          }
        }
        return {
          ok: true,
          json: () =>
            Promise.resolve([{ id: 'resumed-run', status: 'leased' }]),
        }
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const { result, rerender } = renderHook(
        ({ initialRunId }: { initialRunId?: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId,
            followLatest: false,
          }),
        { initialProps: { initialRunId: undefined as string | undefined } },
      )
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('resumed-run'),
      )
      await act(async () => {
        await result.current.trigger({ input: 'test' })
      })
      await waitFor(() => expect(result.current.currentRunId).toBe('user-run'))
      rerender({ initialRunId: 'explicit-run' })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('explicit-run'),
      )
      rerender({ initialRunId: undefined })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('resumed-run'),
      )
    })

    it('installs a leased run without waiting for the pending lookup', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('status=pending'))
          throw new Error('pending lookup failed')
        return {
          ok: true,
          json: () => Promise.resolve([{ id: 'leased-run', status: 'leased' }]),
        }
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('leased-run'),
      )
      expect(result.current.isResolving).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('uses a pending run when the leased lookup fails', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.includes('status=leased'))
          throw new Error('leased lookup failed')
        return {
          ok: true,
          json: () =>
            Promise.resolve([{ id: 'pending-run', status: 'pending' }]),
        }
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch
      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('pending-run'),
      )
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('discards a parsed lookup result after the API changes', async () => {
      let resolveOldJson!: (runs: unknown[]) => void
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.startsWith('/old')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              new Promise((resolve) => {
                resolveOldJson = resolve
              }),
          })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      })
      const { result, rerender } = renderHook(
        ({ api }: { api: string }) => useJob({ api, jobName: 'test-job' }),
        { initialProps: { api: '/old' } },
      )
      await waitFor(() => expect(resolveOldJson).toBeDefined())
      rerender({ api: '/new' })
      await waitFor(() => expect(result.current.isResolving).toBe(false))

      await act(async () => {
        resolveOldJson([{ id: 'old-api-run', status: 'leased' }])
      })
      expect(result.current.currentRunId).toBeNull()
    })

    it('clears provisional status when initialRunId changes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      const { result, rerender } = renderHook(
        ({ initialRunId }: { initialRunId?: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume: false,
            initialRunId,
          }),
        { initialProps: { initialRunId: undefined as string | undefined } },
      )
      const jobSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('jobName=test-job'),
      )!
      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:coalesced',
              runId: 'previous',
              status: 'leased',
            }),
          }),
        )
      })
      expect(result.current.status).toBe('leased')

      rerender({ initialRunId: 'explicit' })
      expect(result.current.currentRunId).toBe('explicit')
      expect(result.current.status).toBeNull()
    })

    it('serializes all triggerOptions and tracks a leased coalesced response', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: 'active-run', status: 'leased' }),
      })
      globalThis.fetch = fetchMock
      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          autoResume: false,
          followLatest: false,
          triggerOptions: {
            idempotencyKey: 'request-1',
            concurrencyKey: 'document:doc-1',
            labels: { documentId: 'doc-1' },
            coalesce: 'active',
          },
        }),
      )

      await result.current.trigger({ input: 'test' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/durably/trigger',
        expect.objectContaining({
          body: JSON.stringify({
            jobName: 'test-job',
            input: { input: 'test' },
            idempotencyKey: 'request-1',
            concurrencyKey: 'document:doc-1',
            labels: { documentId: 'doc-1' },
            coalesce: 'active',
          }),
        }),
      )
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('active-run')
        expect(result.current.status).toBe('leased')
      })
    })

    it('applies triggerOptions to triggerAndWait', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: 'wait-run', status: 'pending' }),
      })
      globalThis.fetch = fetchMock
      const { result } = renderHook(() =>
        useJob<{ input: string }, { result: string }>({
          api: '/api/durably',
          jobName: 'test-job',
          autoResume: false,
          followLatest: false,
          triggerOptions: {
            concurrencyKey: 'document:wait',
            labels: { documentId: 'wait' },
            coalesce: 'active',
          },
        }),
      )

      const waiting = result.current.triggerAndWait({ input: 'test' })
      await waitFor(() => expect(result.current.currentRunId).toBe('wait-run'))
      await waitFor(() =>
        expect(mockEventSource.instances.length).toBeGreaterThan(0),
      )
      act(() => {
        for (const instance of mockEventSource.instances.filter((candidate) =>
          candidate.url.includes('runId=wait-run'),
        )) {
          instance.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'run:complete',
                runId: 'wait-run',
                output: { result: 'done' },
              }),
            }),
          )
        }
      })
      await expect(waiting).resolves.toEqual({
        runId: 'wait-run',
        output: { result: 'done' },
      })
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        concurrencyKey: 'document:wait',
        labels: { documentId: 'wait' },
        coalesce: 'active',
      })
    })

    it('triggerAndWait remains bound to its run when followLatest switches runs', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ runId: 'run-a', status: 'pending' }),
      })
      const { result } = renderHook(() =>
        useJob<{ input: string }, { result: string }>({
          api: '/api/durably',
          jobName: 'test-job',
          autoResume: false,
        }),
      )

      const waiting = result.current.triggerAndWait({ input: 'test' })
      await waitFor(() => {
        expect(result.current.currentRunId).toBe('run-a')
        expect(
          mockEventSource.instances.some((instance) =>
            instance.url.includes('runId=run-a'),
          ),
        ).toBe(true)
      })

      const jobSubscription = mockEventSource.instances.find((instance) =>
        instance.url.includes('/runs/subscribe?'),
      )!
      act(() => {
        jobSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:trigger',
              runId: 'run-b',
              jobName: 'test-job',
            }),
          }),
        )
      })
      await waitFor(() => expect(result.current.currentRunId).toBe('run-b'))

      const runBSubscription = await waitFor(() => {
        const instance = mockEventSource.instances.find((candidate) =>
          candidate.url.includes('runId=run-b'),
        )
        expect(instance).toBeDefined()
        return instance!
      })
      act(() => {
        runBSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:complete',
              runId: 'run-b',
              output: { result: 'from-b' },
            }),
          }),
        )
      })
      await new Promise((resolve) => setTimeout(resolve, 75))

      act(() => {
        for (const instance of mockEventSource.instances.filter((candidate) =>
          candidate.url.includes('runId=run-a'),
        )) {
          instance.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'run:complete',
                runId: 'run-a',
                output: { result: 'from-a' },
              }),
            }),
          )
        }
      })

      await expect(waiting).resolves.toEqual({
        runId: 'run-a',
        output: { result: 'from-a' },
      })
    })

    it('a follow event wins over an older lookup result', async () => {
      let resolveLeased!: (value: unknown) => void
      let resolvePending!: (value: unknown) => void
      const leased = new Promise((resolve) => {
        resolveLeased = resolve
      })
      const pending = new Promise((resolve) => {
        resolvePending = resolve
      })
      globalThis.fetch = vi
        .fn()
        .mockImplementationOnce(() => leased)
        .mockImplementationOnce(() => pending)

      const { result } = renderHook(() =>
        useJob({ api: '/api/durably', jobName: 'test-job' }),
      )
      await waitFor(() =>
        expect(mockEventSource.instances.length).toBeGreaterThan(0),
      )
      act(() => {
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'newer-run',
          jobName: 'test-job',
        })
      })
      await waitFor(() => expect(result.current.currentRunId).toBe('newer-run'))

      await act(async () => {
        resolveLeased({
          ok: true,
          json: () => Promise.resolve([{ id: 'stale-run', status: 'leased' }]),
        })
        resolvePending({ ok: true, json: () => Promise.resolve([]) })
        await Promise.resolve()
      })
      expect(result.current.currentRunId).toBe('newer-run')
      expect(result.current.isResolving).toBe(false)
    })

    it('scope changes reset a prior user trigger and auto-resume the new scope', async () => {
      let phase: 'first' | 'trigger' | 'second' = 'first'
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          phase = 'trigger'
          return {
            ok: true,
            json: () =>
              Promise.resolve({ runId: 'user-run', status: 'pending' }),
          }
        }
        if (phase === 'second' && url.includes('status=leased')) {
          return {
            ok: true,
            json: () =>
              Promise.resolve([{ id: 'new-scope-run', status: 'leased' }]),
          }
        }
        return { ok: true, json: () => Promise.resolve([]) }
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const { result, rerender } = renderHook(
        ({ documentId }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            followLatest: false,
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      await waitFor(() => expect(result.current.isResolving).toBe(false))
      await result.current.trigger({ input: 'test' })
      await waitFor(() => expect(result.current.currentRunId).toBe('user-run'))

      phase = 'second'
      rerender({ documentId: 'second' })
      await waitFor(() => {
        expect(result.current.isResolving).toBe(false)
        expect(result.current.currentRunId).toBe('new-scope-run')
      })
    })

    it('restores a fixed initialRunId after following another run and changing scope', async () => {
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId: 'fixed-run',
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      act(() => {
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'followed-run',
          jobName: 'test-job',
        })
      })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('followed-run'),
      )
      rerender({ documentId: 'second' })
      await waitFor(() => expect(result.current.currentRunId).toBe('fixed-run'))
    })

    it('keeps the current fixed run status when only its scope changes', async () => {
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId: 'fixed-run',
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      const runSubscription = await waitFor(() => {
        const instance = mockEventSource.instances.find((candidate) =>
          candidate.url.includes('runId=fixed-run'),
        )
        expect(instance).toBeDefined()
        return instance!
      })
      act(() => {
        runSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'run:leased', runId: 'fixed-run' }),
          }),
        )
      })
      await waitFor(() => expect(result.current.status).toBe('leased'))
      rerender({ documentId: 'second' })
      expect(result.current.currentRunId).toBe('fixed-run')
      expect(result.current.status).toBe('leased')
      expect(result.current.isActive).toBe(true)
    })

    it('restores a fixed run when scope changes before a trigger response arrives', async () => {
      let resolveTrigger!: (response: {
        ok: boolean
        json: () => Promise<unknown>
      }) => void
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTrigger = resolve
          }),
      )
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId: 'fixed-run',
            followLatest: false,
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      const runSubscription = await waitFor(() => {
        const instance = mockEventSource.instances.find((candidate) =>
          candidate.url.includes('runId=fixed-run'),
        )
        expect(instance).toBeDefined()
        return instance!
      })
      act(() => {
        runSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'run:leased', runId: 'fixed-run' }),
          }),
        )
      })
      expect(result.current.status).toBe('leased')

      let pending!: Promise<{ runId: string }>
      act(() => {
        pending = result.current.trigger({ input: 'test' })
      })
      rerender({ documentId: 'second' })
      expect(result.current.currentRunId).toBe('fixed-run')
      expect(result.current.status).toBe('leased')
      expect(result.current.isPending).toBe(false)

      await act(async () => {
        resolveTrigger({
          ok: true,
          json: () =>
            Promise.resolve({ runId: 'old-scope-run', status: 'pending' }),
        })
        await pending
      })
      expect(result.current.currentRunId).toBe('fixed-run')
      expect(result.current.status).toBe('leased')
    })

    it('clears optimistic pending when a quiet fixed run changes scope during a trigger', async () => {
      let resolveTrigger!: (response: {
        ok: boolean
        json: () => Promise<unknown>
      }) => void
      globalThis.fetch = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveTrigger = resolve
          }),
      )
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId: 'quiet-fixed-run',
            followLatest: false,
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      let pending!: Promise<{ runId: string }>
      act(() => {
        pending = result.current.trigger({ input: 'test' })
      })
      expect(result.current.status).toBe('pending')
      rerender({ documentId: 'second' })
      expect(result.current.currentRunId).toBe('quiet-fixed-run')
      expect(result.current.status).toBeNull()
      expect(result.current.isPending).toBe(false)
      await act(async () => {
        resolveTrigger({
          ok: true,
          json: () =>
            Promise.resolve({ runId: 'old-scope-run', status: 'pending' }),
        })
        await pending
      })
      expect(result.current.currentRunId).toBe('quiet-fixed-run')
      expect(result.current.status).toBeNull()
    })

    it('keeps trigger callbacks stable when the tracked run changes', async () => {
      const { result } = renderHook(() =>
        useJob({ api: '/api/durably', jobName: 'test-job', autoResume: false }),
      )
      const trigger = result.current.trigger
      const triggerAndWait = result.current.triggerAndWait
      act(() => {
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'followed-run',
          jobName: 'test-job',
        })
      })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('followed-run'),
      )
      expect(result.current.trigger).toBe(trigger)
      expect(result.current.triggerAndWait).toBe(triggerAndWait)
    })

    it('accepts a trigger issued in the same handler as reset', async () => {
      let ordinal = 0
      globalThis.fetch = vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              runId: `run-${++ordinal}`,
              status: 'pending',
            }),
        }),
      )
      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          autoResume: false,
          followLatest: false,
        }),
      )
      await act(async () => {
        await result.current.trigger({ input: 'first' })
      })
      expect(result.current.currentRunId).toBe('run-1')

      let pending!: Promise<{ runId: string }>
      act(() => {
        result.current.reset()
        pending = result.current.trigger({ input: 'second' })
      })
      await act(async () => {
        await pending
      })
      expect(result.current.currentRunId).toBe('run-2')
      expect(result.current.status).toBe('pending')
    })

    it('tracks a trigger issued in a layout effect after a scope change', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ runId: 'new-scope-run', status: 'pending' }),
      })
      let pending!: Promise<{ runId: string }>
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) => {
          const job = useJob({
            api: '/api/durably',
            jobName: 'test-job',
            scope: { labels: { documentId } },
            autoResume: false,
            followLatest: false,
          })
          useLayoutEffect(() => {
            if (documentId === 'second') {
              pending = job.trigger({ input: 'new-scope' })
            }
          }, [documentId, job.trigger])
          return job
        },
        { initialProps: { documentId: 'first' } },
      )

      rerender({ documentId: 'second' })
      await act(async () => {
        await pending
      })
      expect(result.current.currentRunId).toBe('new-scope-run')
      expect(result.current.status).toBe('pending')
    })

    it('tracks a child layout-effect trigger during a scope change', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ runId: 'child-scope-run', status: 'pending' }),
      })
      let pending!: Promise<{ runId: string }>
      let currentRunId: string | null = null

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useLayoutEffect(() => {
          if (documentId === 'second') {
            pending = trigger({ input: 'new-scope' })
          }
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob({
          api: '/api/durably',
          jobName: 'test-job',
          scope: { labels: { documentId } },
          autoResume: false,
          followLatest: false,
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(<Parent documentId="first" />)
      rerender(<Parent documentId="second" />)
      await act(async () => {
        await pending
      })
      expect(currentRunId).toBe('child-scope-run')
    })

    it('resumes the new scope when a child layout-effect trigger fails', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trigger')) {
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve('trigger failed'),
          })
        }
        const runs =
          url.includes('label.documentId=second') &&
          url.includes('status=leased')
            ? [{ id: 'existing-new-scope-run', status: 'leased' }]
            : []
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runs),
        })
      })
      let pending!: Promise<{ runId: string }>
      let currentRunId: string | null = null
      let isResolving = true

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useLayoutEffect(() => {
          if (documentId === 'second') {
            pending = trigger({ input: 'new-scope' })
          }
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob({
          api: '/api/durably',
          jobName: 'test-job',
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        isResolving = job.isResolving
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(<Parent documentId="first" />)
      await waitFor(() => expect(isResolving).toBe(false))
      rerender(<Parent documentId="second" />)
      await act(async () => {
        await expect(pending).rejects.toThrow('trigger failed')
      })
      await waitFor(() => expect(currentRunId).toBe('existing-new-scope-run'))
    })

    it('keeps a matching follow ahead of a lookup restarted after trigger failure', async () => {
      let triggerFailed = false
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trigger')) {
          triggerFailed = true
          return Promise.resolve({
            ok: false,
            status: 400,
            text: () => Promise.resolve('trigger failed'),
          })
        }
        const runs =
          triggerFailed && url.includes('status=leased')
            ? [{ id: 'older-leased-run', status: 'leased' }]
            : []
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runs),
        })
      })
      globalThis.fetch = fetchMock

      const { result } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          scope: { labels: { documentId: 'doc-a' } },
        }),
      )
      await waitFor(() => expect(result.current.isResolving).toBe(false))

      await act(async () => {
        await expect(result.current.trigger({ input: 'test' })).rejects.toThrow(
          'trigger failed',
        )
        mockEventSource.emit({
          type: 'run:trigger',
          runId: 'newer-followed-run',
        })
      })

      expect(result.current.currentRunId).toBe('newer-followed-run')
      expect(result.current.status).toBe('pending')
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          (url as string).includes('status=leased'),
        ),
      ).toHaveLength(1)
    })

    it('looks up a new run when auto-resume is enabled after a prior follow', async () => {
      let newerRunAvailable = false
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        const runs =
          newerRunAvailable && url.includes('status=leased')
            ? [{ id: 'newer-leased-run', status: 'leased' }]
            : []
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runs),
        })
      })
      globalThis.fetch = fetchMock
      const { result, rerender } = renderHook(
        ({
          autoResume,
          followLatest,
        }: {
          autoResume: boolean
          followLatest: boolean
        }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume,
            followLatest,
          }),
        { initialProps: { autoResume: false, followLatest: true } },
      )

      act(() => {
        mockEventSource.emit({ type: 'run:trigger', runId: 'old-run' })
      })
      await waitFor(() => expect(result.current.currentRunId).toBe('old-run'))
      act(() => {
        mockEventSource.emit({ type: 'run:complete', runId: 'old-run' })
      })
      await waitFor(() => expect(result.current.isTerminal).toBe(true))

      rerender({ autoResume: false, followLatest: false })
      newerRunAvailable = true
      rerender({ autoResume: true, followLatest: false })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('newer-leased-run'),
      )
      expect(result.current.status).toBe('leased')
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('status=leased'),
        expect.any(Object),
      )
    })

    it('resumes after a follow supersedes a trigger that later fails', async () => {
      let rejectTrigger!: (error: Error) => void
      let newerRunAvailable = false
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trigger')) {
          return new Promise((_, reject) => {
            rejectTrigger = reject
          })
        }
        const runs =
          newerRunAvailable && url.includes('status=leased')
            ? [{ id: 'newer-leased-run', status: 'leased' }]
            : []
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runs),
        })
      })
      globalThis.fetch = fetchMock
      const { result, rerender } = renderHook(
        ({
          autoResume,
          followLatest,
        }: {
          autoResume: boolean
          followLatest: boolean
        }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume,
            followLatest,
          }),
        { initialProps: { autoResume: false, followLatest: true } },
      )

      const pending = result.current.trigger({ input: 'test' })
      act(() => {
        mockEventSource.emit({ type: 'run:trigger', runId: 'followed-run' })
      })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('followed-run'),
      )
      await act(async () => {
        rejectTrigger(new Error('trigger failed'))
        await expect(pending).rejects.toThrow('trigger failed')
      })
      act(() => {
        mockEventSource.emit({ type: 'run:complete', runId: 'followed-run' })
      })
      await waitFor(() => expect(result.current.isTerminal).toBe(true))

      rerender({ autoResume: false, followLatest: false })
      newerRunAvailable = true
      rerender({ autoResume: true, followLatest: false })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('newer-leased-run'),
      )
    })

    it('keeps an explicit run when its own follow arrives before trigger success', async () => {
      let resolveTrigger!: (response: unknown) => void
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trigger')) {
          return new Promise((resolve) => {
            resolveTrigger = resolve
          })
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([{ id: 'older-leased-run', status: 'leased' }]),
        })
      })
      globalThis.fetch = fetchMock
      const { result, rerender } = renderHook(
        ({
          autoResume,
          followLatest,
        }: {
          autoResume: boolean
          followLatest: boolean
        }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume,
            followLatest,
          }),
        { initialProps: { autoResume: false, followLatest: true } },
      )

      const pending = result.current.trigger({ input: 'test' })
      act(() => {
        mockEventSource.emit({ type: 'run:trigger', runId: 'explicit-run' })
      })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('explicit-run'),
      )
      await act(async () => {
        resolveTrigger({
          ok: true,
          json: () =>
            Promise.resolve({ runId: 'explicit-run', status: 'pending' }),
        })
        await expect(pending).resolves.toEqual({ runId: 'explicit-run' })
      })

      rerender({ autoResume: false, followLatest: false })
      rerender({ autoResume: true, followLatest: false })
      expect(result.current.currentRunId).toBe('explicit-run')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('releases explicit ownership when another run is followed before trigger success', async () => {
      let resolveTrigger!: (response: unknown) => void
      let newerRunAvailable = false
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.endsWith('/trigger')) {
          return new Promise((resolve) => {
            resolveTrigger = resolve
          })
        }
        const runs =
          newerRunAvailable && url.includes('status=leased')
            ? [{ id: 'newer-leased-run', status: 'leased' }]
            : []
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runs),
        })
      })
      globalThis.fetch = fetchMock
      const { result, rerender } = renderHook(
        ({
          autoResume,
          followLatest,
        }: {
          autoResume: boolean
          followLatest: boolean
        }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            autoResume,
            followLatest,
          }),
        { initialProps: { autoResume: false, followLatest: true } },
      )

      const pending = result.current.trigger({ input: 'test' })
      act(() => {
        mockEventSource.emit({ type: 'run:trigger', runId: 'followed-run' })
      })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('followed-run'),
      )
      await act(async () => {
        resolveTrigger({
          ok: true,
          json: () =>
            Promise.resolve({ runId: 'explicit-run', status: 'pending' }),
        })
        await expect(pending).resolves.toEqual({ runId: 'explicit-run' })
      })
      act(() => {
        mockEventSource.emit({ type: 'run:complete', runId: 'followed-run' })
      })
      await waitFor(() => expect(result.current.isTerminal).toBe(true))

      rerender({ autoResume: false, followLatest: false })
      newerRunAvailable = true
      rerender({ autoResume: true, followLatest: false })
      await waitFor(() =>
        expect(result.current.currentRunId).toBe('newer-leased-run'),
      )
    })

    it('tracks a trigger issued in a layout effect after an API change', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ runId: 'new-api-run', status: 'pending' }),
      })
      let pending!: Promise<{ runId: string }>
      const { result, rerender } = renderHook(
        ({ api }: { api: string }) => {
          const job = useJob({
            api,
            jobName: 'test-job',
            autoResume: false,
            followLatest: false,
          })
          useLayoutEffect(() => {
            if (api === '/new') {
              pending = job.trigger({ input: 'new-api' })
            }
          }, [api, job.trigger])
          return job
        },
        { initialProps: { api: '/old' } },
      )

      rerender({ api: '/new' })
      await act(async () => {
        await pending
      })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/new/trigger',
        expect.any(Object),
      )
      expect(result.current.currentRunId).toBe('new-api-run')
      expect(result.current.status).toBe('pending')
    })

    it('clears the previous API run if a post-change layout trigger fails', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url === '/old/trigger'
            ? {
                ok: true,
                json: () =>
                  Promise.resolve({ runId: 'old-run', status: 'pending' }),
              }
            : { ok: false, text: () => Promise.resolve('new source failed') },
        ),
      )
      let pending!: Promise<{ runId: string }>
      const { result, rerender } = renderHook(
        ({ api }: { api: string }) => {
          const job = useJob({
            api,
            jobName: 'test-job',
            autoResume: false,
            followLatest: false,
          })
          useLayoutEffect(() => {
            if (api === '/new') pending = job.trigger({ input: 'new-api' })
          }, [api, job.trigger])
          return job
        },
        { initialProps: { api: '/old' } },
      )
      await act(async () => {
        await result.current.trigger({ input: 'old-api' })
      })
      expect(result.current.currentRunId).toBe('old-run')

      rerender({ api: '/new' })
      await act(async () => {
        await expect(pending).rejects.toThrow('new source failed')
      })
      expect(result.current.currentRunId).toBeNull()
      expect(result.current.status).toBeNull()
    })

    it('ignores an event from the previous scope after its subscription closes', () => {
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob({
            api: '/api/durably',
            jobName: 'test-job',
            initialRunId: 'fixed-run',
            scope: { labels: { documentId } },
          }),
        { initialProps: { documentId: 'first' } },
      )
      const oldSubscription = mockEventSource.instances.find(
        (instance) =>
          instance.url.includes('/runs/subscribe?') &&
          instance.url.includes('label.documentId=first'),
      )!
      rerender({ documentId: 'second' })
      act(() => {
        oldSubscription.onmessage?.(
          new MessageEvent('message', {
            data: JSON.stringify({
              type: 'run:trigger',
              runId: 'old-scope-run',
            }),
          }),
        )
      })
      expect(result.current.currentRunId).toBe('fixed-run')
    })

    it('does not let a retained callback trigger a previous API source', async () => {
      const fetchMock = vi.fn()
      globalThis.fetch = fetchMock
      const { result, rerender } = renderHook(
        ({ api }: { api: string }) =>
          useJob({
            api,
            jobName: 'test-job',
            initialRunId: 'fixed-run',
            autoResume: false,
            followLatest: false,
          }),
        { initialProps: { api: '/old' } },
      )
      const oldTrigger = result.current.trigger
      rerender({ api: '/new' })
      await expect(oldTrigger({ input: 'test' })).rejects.toThrow(
        'Job source changed',
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result.current.currentRunId).toBe('fixed-run')
      expect(result.current.status).toBeNull()
    })

    it('owns rejected and aborted lookups and settles resolving state', async () => {
      const consoleError = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('lookup failed'))
      const { result, unmount } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          followLatest: false,
        }),
      )
      await waitFor(() => expect(result.current.isResolving).toBe(false))
      expect(consoleError).toHaveBeenCalledTimes(1)
      unmount()
    })

    it('inline scope and trigger option objects do not recreate work', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      globalThis.fetch = fetchMock
      const { rerender } = renderHook(() =>
        useJob({
          api: '/api/durably',
          jobName: 'test-job',
          scope: { labels: { documentId: 'stable' } },
          triggerOptions: {
            labels: { documentId: 'stable' },
            concurrencyKey: 'document:stable',
            coalesce: 'active',
          },
        }),
      )
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      const eventSourceCount = mockEventSource.instances.length
      rerender()
      await act(async () => Promise.resolve())
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(mockEventSource.instances).toHaveLength(eventSourceCount)
    })

    it('reordered but equal label records do not recreate work', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([]),
      })
      globalThis.fetch = fetchMock
      const { rerender } = renderHook(
        ({ reverse }) => {
          const labels = reverse
            ? { tenant: 'acme', documentId: 'stable' }
            : { documentId: 'stable', tenant: 'acme' }
          return useJob({
            api: '/api/durably',
            jobName: 'test-job',
            scope: { labels },
            triggerOptions: { labels },
          })
        },
        { initialProps: { reverse: false } },
      )
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
      const eventSourceCount = mockEventSource.instances.length
      rerender({ reverse: true })
      await act(async () => Promise.resolve())
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(mockEventSource.instances).toHaveLength(eventSourceCount)
    })
  })
})
