/**
 * createDurablyClient Tests
 *
 * Test the type-safe client factory.
 * Note: Hook behavior (SSE subscription, logs, etc.) is tested in the individual hook tests.
 * These tests focus on the factory's proxy behavior and job name mapping.
 */

import { renderHook } from '@testing-library/react'
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

  it('creates a client with job accessors via proxy', () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    // Verify the proxy creates job clients on access
    expect(client.importCsv).toBeDefined()
    expect(client.syncUsers).toBeDefined()
    expect(client.importCsv.useJob).toBeTypeOf('function')
    expect(client.importCsv.useRun).toBeTypeOf('function')
    expect(client.importCsv.useLogs).toBeTypeOf('function')
  })

  it('maps property name to jobName in trigger', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'test-run-id' }),
    })
    globalThis.fetch = fetchMock

    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const { result } = renderHook(() => client.importCsv.useJob())
    await result.current.trigger({ filename: 'data.csv' })

    // Verify jobName is derived from property name 'importCsv'
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: JSON.stringify({
          jobName: 'importCsv',
          input: { filename: 'data.csv' },
        }),
      }),
    )
  })

  it('different properties map to different job names', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'run-1' }),
    })
    globalThis.fetch = fetchMock

    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    // Trigger via importCsv
    const { result: importResult } = renderHook(() => client.importCsv.useJob())
    await importResult.current.trigger({ filename: 'test.csv' })

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: expect.stringContaining('"jobName":"importCsv"'),
      }),
    )

    // Trigger via syncUsers - should use different jobName
    const { result: syncResult } = renderHook(() => client.syncUsers.useJob())
    await syncResult.current.trigger({ orgId: 'org-123' })

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: expect.stringContaining('"jobName":"syncUsers"'),
      }),
    )
  })

  it('useRun returns a hook function', () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const { result } = renderHook(() => client.importCsv.useRun(null))

    // Verify the hook returns expected shape
    expect(result.current.status).toBeNull()
  })

  it('useLogs returns a hook function', () => {
    const client = createDurablyClient<MockJobs>({ api: '/api/durably' })

    const { result } = renderHook(() => client.importCsv.useLogs(null))

    // Verify the hook returns expected shape
    expect(result.current.logs).toEqual([])
  })
})
