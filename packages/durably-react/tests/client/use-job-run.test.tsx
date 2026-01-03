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

  it('updates status when run is cancelled', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'cancel-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:cancel',
        runId: 'cancel-run',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('cancelled')
      expect(result.current.isCancelled).toBe(true)
    })
  })

  it('resets status when run is retried', async () => {
    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'retry-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    // First fail the run
    act(() => {
      mockEventSource.emit({
        type: 'run:fail',
        runId: 'retry-run',
        error: 'Something went wrong',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('Something went wrong')
    })

    // Then retry it
    act(() => {
      mockEventSource.emit({
        type: 'run:retry',
        runId: 'retry-run',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('pending')
      expect(result.current.error).toBeNull()
      expect(result.current.isPending).toBe(true)
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

    // With runId set, status starts as 'pending' until SSE events arrive
    expect(result.current.status).toBe('pending')

    act(() => {
      mockEventSource.emit({ type: 'run:start', runId: 'other-run' })
    })

    // Status should remain 'pending' since event is for a different run
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.status).toBe('pending')
  })

  describe('callbacks', () => {
    it('fires onStart only once when transitioning from null to pending to running', async () => {
      const onStart = vi.fn()

      const { result } = renderHook(() =>
        useJobRun({ api: '/api/durably', runId: 'callback-run', onStart }),
      )

      // Initially pending (runId exists but no SSE events yet)
      await waitFor(() => {
        expect(result.current.status).toBe('pending')
      })

      // onStart should have been called once for pending status
      expect(onStart).toHaveBeenCalledTimes(1)

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      // Emit run:start to transition to running
      act(() => {
        mockEventSource.emit({ type: 'run:start', runId: 'callback-run' })
      })

      await waitFor(() => {
        expect(result.current.status).toBe('running')
      })

      // onStart should NOT have been called again - still just once
      expect(onStart).toHaveBeenCalledTimes(1)
    })

    it('fires onComplete when run completes', async () => {
      const onComplete = vi.fn()

      const { result } = renderHook(() =>
        useJobRun({
          api: '/api/durably',
          runId: 'complete-callback-run',
          onComplete,
        }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:complete',
          runId: 'complete-callback-run',
          output: { done: true },
        })
      })

      await waitFor(() => {
        expect(result.current.isCompleted).toBe(true)
      })

      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('fires onFail when run fails', async () => {
      const onFail = vi.fn()

      const { result } = renderHook(() =>
        useJobRun({
          api: '/api/durably',
          runId: 'fail-callback-run',
          onFail,
        }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:fail',
          runId: 'fail-callback-run',
          error: 'Test error',
        })
      })

      await waitFor(() => {
        expect(result.current.isFailed).toBe(true)
      })

      expect(onFail).toHaveBeenCalledTimes(1)
    })
  })
})
