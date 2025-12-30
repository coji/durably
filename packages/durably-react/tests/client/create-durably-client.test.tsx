/**
 * createDurablyClient Tests
 *
 * Test the type-safe client factory
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDurablyClient } from '../../src/client/create-durably-client'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

// Mock job types for type inference testing
type MockJobs = {
  [key: string]: unknown
  importCsv: {
    trigger: (input: { filename: string }) => Promise<{
      output: { rowCount: number }
    }>
  }
  syncUsers: {
    trigger: (input: { orgId: string }) => Promise<{
      output: { syncedCount: number }
    }>
  }
}

describe('createDurablyClient', () => {
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

  it('creates a client with job accessors', () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    // Verify the proxy creates job clients on access
    expect(client.importCsv).toBeDefined()
    expect(client.syncUsers).toBeDefined()
    expect(client.importCsv.useJob).toBeTypeOf('function')
    expect(client.importCsv.useRun).toBeTypeOf('function')
    expect(client.importCsv.useLogs).toBeTypeOf('function')
  })

  it('useJob triggers correct job name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'test-run-id' }),
    })
    globalThis.fetch = fetchMock

    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const { result } = renderHook(() => client.importCsv.useJob())

    expect(result.current.isReady).toBe(true)

    await result.current.trigger({ filename: 'data.csv' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jobName: 'importCsv',
          input: { filename: 'data.csv' },
        }),
      }),
    )
  })

  it('useRun subscribes to run by ID', async () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() =>
      client.importCsv.useRun('test-run-123'),
    )

    // Wait for EventSource to be created
    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(instanceCountBefore)
    })

    // Verify SSE subscription URL - get the latest instance
    const instance = mockEventSource.instances[mockEventSource.instances.length - 1]
    expect(instance.url).toContain('/api/durably/subscribe?runId=test-run-123')

    // Emit complete event
    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'test-run-123',
        output: { rowCount: 42 },
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('completed')
      expect(result.current.output).toEqual({ rowCount: 42 })
    })
  })

  it('useLogs subscribes to logs from run', async () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() =>
      client.importCsv.useLogs('log-run-123', { maxLogs: 50 }),
    )

    // Wait for EventSource to be created
    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(instanceCountBefore)
    })

    // Emit log event
    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'log-run-123',
        level: 'info',
        message: 'Processing row 1',
        data: null,
      })
    })

    await waitFor(() => {
      expect(result.current.logs.length).toBe(1)
      expect(result.current.logs[0].message).toBe('Processing row 1')
    })
  })

  it('different jobs use different job names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'run-1' }),
    })
    globalThis.fetch = fetchMock

    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    // Test importCsv
    const { result: importResult } = renderHook(() => client.importCsv.useJob())
    await importResult.current.trigger({ filename: 'test.csv' })

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: expect.stringContaining('"jobName":"importCsv"'),
      }),
    )

    // Test syncUsers
    const { result: syncResult } = renderHook(() => client.syncUsers.useJob())
    await syncResult.current.trigger({ orgId: 'org-123' })

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: expect.stringContaining('"jobName":"syncUsers"'),
      }),
    )
  })

  it('useRun with null runId does not subscribe', async () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => client.importCsv.useRun(null))

    // Wait a bit to ensure no NEW EventSource is created
    await new Promise((r) => setTimeout(r, 50))
    expect(mockEventSource.instances.length).toBe(instanceCountBefore)
    expect(result.current.status).toBeNull()
  })

  it('useLogs with null runId does not subscribe', async () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => client.importCsv.useLogs(null))

    // Wait a bit to ensure no NEW EventSource is created
    await new Promise((r) => setTimeout(r, 50))
    expect(mockEventSource.instances.length).toBe(instanceCountBefore)
    expect(result.current.logs).toEqual([])
  })
})
