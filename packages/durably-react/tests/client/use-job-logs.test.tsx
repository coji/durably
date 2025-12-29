/**
 * Client mode useJobLogs tests
 *
 * Test log subscription via SSE
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJobLogs } from '../../src/client/use-job-logs'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

describe('useJobLogs (client)', () => {
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

  it('collects logs from SSE', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'log-run' }),
    )

    expect(result.current.isReady).toBe(true)

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'log-run',
        level: 'info',
        message: 'Log 1',
        data: null,
      })
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'log-run',
        level: 'warn',
        message: 'Log 2',
        data: { warning: true },
      })
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2)
      expect(result.current.logs[0].message).toBe('Log 1')
      expect(result.current.logs[0].level).toBe('info')
      expect(result.current.logs[1].message).toBe('Log 2')
      expect(result.current.logs[1].level).toBe('warn')
    })
  })

  it('handles null runId', () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: null }),
    )

    expect(result.current.logs).toHaveLength(0)
    expect(mockEventSource.instances).toHaveLength(0)
  })

  it('respects maxLogs limit', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'max-logs-run', maxLogs: 2 }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    // Emit 3 logs
    for (let i = 0; i < 3; i++) {
      act(() => {
        mockEventSource.emit({
          type: 'log:write',
          runId: 'max-logs-run',
          level: 'info',
          message: `Log ${i}`,
          data: null,
        })
      })
    }

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2)
      // First log should be removed, keep the last 2
      expect(result.current.logs[0].message).toBe('Log 1')
      expect(result.current.logs[1].message).toBe('Log 2')
    })
  })

  it('clears logs on clearLogs call', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'clear-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'clear-run',
        level: 'info',
        message: 'Test log',
        data: null,
      })
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1)
    })

    act(() => {
      result.current.clearLogs()
    })

    expect(result.current.logs).toHaveLength(0)
  })

  it('ignores logs for different runId', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'my-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'other-run',
        level: 'info',
        message: 'Wrong log',
        data: null,
      })
    })

    // Wait a bit and check logs are still empty
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current.logs).toHaveLength(0)
  })

  it('closes EventSource on unmount', async () => {
    const closeSpy = vi.fn()
    mockEventSource = createMockEventSource({ onClose: closeSpy })
    globalThis.EventSource = mockEventSource as unknown as typeof EventSource

    const { unmount } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'unmount-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    unmount()

    expect(closeSpy).toHaveBeenCalled()
  })

  it('provides log metadata', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'metadata-run' }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'metadata-run',
        level: 'error',
        message: 'Error occurred',
        data: { code: 500 },
      })
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1)
      const log = result.current.logs[0]
      expect(log.id).toBeDefined()
      expect(log.runId).toBe('metadata-run')
      expect(log.level).toBe('error')
      expect(log.message).toBe('Error occurred')
      expect(log.data).toEqual({ code: 500 })
      expect(log.timestamp).toBeDefined()
    })
  })
})
