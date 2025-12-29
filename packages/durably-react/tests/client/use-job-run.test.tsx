/**
 * Client mode useJobRun tests
 *
 * Test SSE subscription for existing runs
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJobRun } from '../../src/client/use-job-run'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

describe('useJobRun (client)', () => {
  let mockEventSource: MockEventSourceConstructor
  let originalEventSource: typeof EventSource

  beforeEach(() => {
    mockEventSource = createMockEventSource()
    originalEventSource = globalThis.EventSource
    globalThis.EventSource = mockEventSource as unknown as typeof EventSource
  })

  afterEach(() => {
    globalThis.EventSource = originalEventSource
    vi.restoreAllMocks()
  })

  it('subscribes to run via SSE', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'existing-run' }),
    )

    expect(result.current.isReady).toBe(true)

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    // Check URL is correct
    expect(mockEventSource.instances[0].url).toBe(
      '/api/durably/subscribe?runId=existing-run',
    )

    act(() => {
      mockEventSource.emit({ type: 'run:start', runId: 'existing-run' })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('running')
      expect(result.current.isRunning).toBe(true)
    })
  })

  it('does not subscribe when runId is null', () => {
    renderHook(() => useJobRun({ api: '/api/durably', runId: null }))

    expect(mockEventSource.instances).toHaveLength(0)
  })

  it('provides output when run completes', async () => {
    const { result } = renderHook(() =>
      useJobRun<{ value: number }>({
        api: '/api/durably',
        runId: 'complete-run',
      }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'complete-run',
        output: { value: 42 },
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('completed')
      expect(result.current.output).toEqual({ value: 42 })
      expect(result.current.isCompleted).toBe(true)
    })
  })

  it('provides error when run fails', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'fail-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:fail',
        runId: 'fail-run',
        error: 'Something went wrong',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('Something went wrong')
      expect(result.current.isFailed).toBe(true)
    })
  })

  it('tracks progress updates', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'progress-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:progress',
        runId: 'progress-run',
        progress: { current: 5, total: 10, message: 'Processing' },
      })
    })

    await waitFor(() => {
      expect(result.current.progress).toEqual({
        current: 5,
        total: 10,
        message: 'Processing',
      })
    })
  })

  it('collects logs', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'log-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'log-run',
        level: 'info',
        message: 'Step 1 complete',
        data: { step: 1 },
      })
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1)
      expect(result.current.logs[0].message).toBe('Step 1 complete')
      expect(result.current.logs[0].level).toBe('info')
    })
  })

  it('closes EventSource on unmount', async () => {
    const closeSpy = vi.fn()
    mockEventSource = createMockEventSource({ onClose: closeSpy })
    globalThis.EventSource = mockEventSource as unknown as typeof EventSource

    const { unmount } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'unmount-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    unmount()

    expect(closeSpy).toHaveBeenCalled()
  })

  it('ignores events for different runId', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'my-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({ type: 'run:start', runId: 'other-run' })
    })

    // Status should remain null since event is for a different run
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.status).toBeNull()
  })
})
