/**
 * Client mode useRuns tests
 *
 * Test runs listing via fetch and SSE subscription
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRuns, type ClientRun } from '../../src/client/use-runs'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

const createMockRun = (overrides: Partial<ClientRun> = {}): ClientRun => ({
  id: 'run-1',
  jobName: 'test-job',
  status: 'pending',
  input: { value: 1 },
  output: null,
  error: null,
  currentStepIndex: 0,
  completedStepCount: 0,
  labels: {},
  progress: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  startedAt: null,
  completedAt: null,
  isTerminal: false,
  isActive: true,
  ...overrides,
})

describe('useRuns (client)', () => {
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

  it('fetches runs on mount', async () => {
    const mockRuns = [
      createMockRun({ id: 'run-1' }),
      createMockRun({ id: 'run-2' }),
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRuns),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    expect(result.current.isLoading).toBe(true)

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/durably/runs?'),
    )
    expect(result.current.runs).toHaveLength(2)
    expect(result.current.runs[0].id).toBe('run-1')
  })

  it('filters by jobName', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably', jobName: 'my-job' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('jobName=my-job')
  })

  it('filters by status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably', status: 'completed' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('status=completed')
  })

  it('appends multiple status params to the request URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() =>
      useRuns({ api: '/api/durably', status: ['pending', 'leased'] }),
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
    })

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('status=pending')
    expect(url).toContain('status=leased')
  })

  it('does not refetch when the same status array values are passed on re-render', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    const { rerender } = renderHook(() =>
      useRuns({ api: '/api/durably', status: ['pending', 'leased'] }),
    )

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    rerender()

    expect(fetchMock.mock.calls.length).toBe(1)
  })

  it('handles pagination', async () => {
    const page1Runs = [
      createMockRun({ id: 'run-1' }),
      createMockRun({ id: 'run-2' }),
      createMockRun({ id: 'run-3' }), // Extra item indicates hasMore
    ]
    const page2Runs = [createMockRun({ id: 'run-4' })]

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page1Runs),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(page2Runs),
      })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useRuns({ api: '/api/durably', pageSize: 2 }),
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.runs).toHaveLength(2)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.page).toBe(0)

    // Go to next page
    act(() => {
      result.current.nextPage()
    })

    await waitFor(() => {
      expect(result.current.page).toBe(1)
    })

    await waitFor(() => {
      expect(result.current.runs[0].id).toBe('run-4')
    })
  })

  it('subscribes to SSE on first page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    expect(mockEventSource.instances[0].url).toContain(
      '/api/durably/runs/subscribe',
    )
  })

  it('includes jobName filter in SSE URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably', jobName: 'my-job' }))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    expect(mockEventSource.instances[0].url).toContain('jobName=my-job')
  })

  it('refreshes on run:leased event', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    const initialCallCount = fetchMock.mock.calls.length

    act(() => {
      mockEventSource.emit({
        type: 'run:leased',
        runId: 'new-run',
        jobName: 'test-job',
      })
    })

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
  })

  it('refreshes on run:complete event', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    const initialCallCount = fetchMock.mock.calls.length

    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'run-1',
        jobName: 'test-job',
      })
    })

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
  })

  it('refreshes on run:fail event', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    const initialCallCount = fetchMock.mock.calls.length

    act(() => {
      mockEventSource.emit({
        type: 'run:fail',
        runId: 'run-1',
        jobName: 'test-job',
      })
    })

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
  })

  it('updates progress in place on run:progress event', async () => {
    const mockRuns = [
      createMockRun({ id: 'run-1', status: 'leased' }),
      createMockRun({ id: 'run-2', status: 'leased' }),
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRuns),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(result.current.runs).toHaveLength(2)
    })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    const callCountBeforeProgress = fetchMock.mock.calls.length

    act(() => {
      mockEventSource.emit({
        type: 'run:progress',
        runId: 'run-1',
        jobName: 'test-job',
        progress: { current: 5, total: 10, message: 'Processing...' },
      })
    })

    await waitFor(() => {
      expect(result.current.runs[0].progress).toEqual({
        current: 5,
        total: 10,
        message: 'Processing...',
      })
    })

    // Verify no fetch was triggered for progress update
    expect(fetchMock.mock.calls.length).toBe(callCountBeforeProgress)

    // Other runs should not be affected
    expect(result.current.runs[1].progress).toBeNull()
  })

  it('keeps the highest step index when parallel steps complete out of order', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([createMockRun({ id: 'run-1', status: 'leased' })]),
    })

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    await waitFor(() =>
      expect(mockEventSource.instances.length).toBeGreaterThan(0),
    )

    act(() => {
      mockEventSource.emit({
        type: 'step:complete',
        runId: 'run-1',
        jobName: 'test-job',
        stepIndex: 1,
      })
      mockEventSource.emit({
        type: 'step:complete',
        runId: 'run-1',
        jobName: 'test-job',
        stepIndex: 0,
      })
    })

    expect(result.current.runs[0].currentStepIndex).toBe(2)
  })

  it('refreshes the completed count while another parallel branch is active', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([createMockRun({ id: 'run-1', status: 'leased' })]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            createMockRun({
              id: 'run-1',
              status: 'leased',
              currentStepIndex: 2,
              completedStepCount: 1,
            }),
          ]),
      })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    await waitFor(() =>
      expect(mockEventSource.instances.length).toBeGreaterThan(0),
    )

    act(() => {
      mockEventSource.emit({
        type: 'step:complete',
        runId: 'run-1',
        jobName: 'test-job',
        stepIndex: 1,
      })
    })

    await waitFor(() => {
      expect(result.current.runs[0].status).toBe('leased')
      expect(result.current.runs[0].completedStepCount).toBe(1)
      expect(result.current.runs[0].currentStepIndex).toBe(2)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not replace a completed-step index with a delayed refresh response', async () => {
    let resolveRefresh!: (response: {
      ok: boolean
      json: () => Promise<ClientRun[]>
    }) => void
    const delayedRefresh = new Promise<{
      ok: boolean
      json: () => Promise<ClientRun[]>
    }>((resolve) => {
      resolveRefresh = resolve
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([createMockRun({ id: 'run-1', status: 'leased' })]),
      })
      .mockReturnValueOnce(delayedRefresh)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            createMockRun({
              id: 'run-1',
              status: 'leased',
              currentStepIndex: 2,
              completedStepCount: 1,
            }),
          ]),
      })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))
    await waitFor(() => expect(result.current.runs).toHaveLength(1))
    await waitFor(() =>
      expect(mockEventSource.instances.length).toBeGreaterThan(0),
    )

    act(() => {
      mockEventSource.emit({
        type: 'step:start',
        runId: 'run-1',
        jobName: 'test-job',
        stepIndex: 1,
      })
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    act(() => {
      mockEventSource.emit({
        type: 'step:complete',
        runId: 'run-1',
        jobName: 'test-job',
        stepIndex: 1,
      })
    })
    expect(result.current.runs[0].currentStepIndex).toBe(2)

    await act(async () => {
      resolveRefresh({
        ok: true,
        json: () =>
          Promise.resolve([createMockRun({ id: 'run-1', status: 'leased' })]),
      })
      await delayedRefresh
    })
    expect(result.current.runs[0].currentStepIndex).toBe(2)
  })

  it('does not subscribe to SSE on non-first pages', async () => {
    const page1Runs = [
      createMockRun({ id: 'run-1' }),
      createMockRun({ id: 'run-2' }),
      createMockRun({ id: 'run-3' }), // Extra for hasMore
    ]
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(page1Runs),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() =>
      useRuns({ api: '/api/durably', pageSize: 2 }),
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    const instancesOnPage0 = mockEventSource.instances.length

    act(() => {
      result.current.nextPage()
    })

    await waitFor(() => {
      expect(result.current.page).toBe(1)
    })

    // EventSource should be closed, no new instances created
    // (actually the old one is closed but counts remain)
    expect(mockEventSource.instances[instancesOnPage0 - 1].readyState).toBe(2) // CLOSED
  })

  it('handles fetch errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Internal Server Error',
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(result.current.error).toBe(
        'Failed to fetch runs: Internal Server Error',
      )
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.runs).toEqual([])
  })

  it('refresh reloads data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([createMockRun({ id: 'run-1' })]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            createMockRun({ id: 'run-1' }),
            createMockRun({ id: 'run-2' }),
          ]),
      })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(result.current.runs).toHaveLength(1)
    })

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.runs).toHaveLength(2)
  })

  it('goToPage navigates directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    act(() => {
      result.current.goToPage(5)
    })

    await waitFor(() => {
      expect(result.current.page).toBe(5)
    })
  })

  it('prevPage does not go below 0', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    })
    globalThis.fetch = fetchMock

    const { result } = renderHook(() => useRuns({ api: '/api/durably' }))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.page).toBe(0)

    act(() => {
      result.current.prevPage()
    })

    expect(result.current.page).toBe(0)
  })
})
