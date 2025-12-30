/**
 * createJobHooks Tests
 *
 * Test the type-safe job hooks factory
 */

import { defineJob } from '@coji/durably'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createJobHooks } from '../../src/client/create-job-hooks'
import {
  createMockEventSource,
  type MockEventSourceConstructor,
} from './mock-event-source'

// Define a mock job for type inference
const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({ filename: z.string(), delimiter: z.string().optional() }),
  output: z.object({ rowCount: z.number(), errors: z.number() }),
  run: async () => ({ rowCount: 100, errors: 0 }),
})

describe('createJobHooks', () => {
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

  it('creates hooks object with useJob, useRun, useLogs', () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    expect(hooks.useJob).toBeTypeOf('function')
    expect(hooks.useRun).toBeTypeOf('function')
    expect(hooks.useLogs).toBeTypeOf('function')
  })

  it('useJob triggers with correct job name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'csv-run-id' }),
    })
    globalThis.fetch = fetchMock

    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useJob())

    expect(result.current.isReady).toBe(true)

    await result.current.trigger({ filename: 'data.csv' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          jobName: 'import-csv',
          input: { filename: 'data.csv' },
        }),
      }),
    )
  })

  it('useJob handles completion with typed output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'typed-run-id' }),
    })
    globalThis.fetch = fetchMock

    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useJob())

    await result.current.trigger({ filename: 'test.csv' })

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(0)
    })

    act(() => {
      mockEventSource.emit({
        type: 'run:complete',
        runId: 'typed-run-id',
        output: { rowCount: 500, errors: 2 },
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('completed')
      expect(result.current.output).toEqual({ rowCount: 500, errors: 2 })
      // Type should be inferred correctly
      expect(result.current.output?.rowCount).toBe(500)
      expect(result.current.output?.errors).toBe(2)
    })
  })

  it('useRun subscribes to existing run', async () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => hooks.useRun('existing-run-123'))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(instanceCountBefore)
    })

    const instance = mockEventSource.instances[mockEventSource.instances.length - 1]
    expect(instance.url).toContain(
      '/api/durably/subscribe?runId=existing-run-123',
    )

    act(() => {
      mockEventSource.emit({
        type: 'run:start',
        runId: 'existing-run-123',
      })
    })

    await waitFor(() => {
      expect(result.current.status).toBe('running')
      expect(result.current.isRunning).toBe(true)
    })
  })

  it('useLogs collects logs from run', async () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => hooks.useLogs('logs-run-123'))

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(instanceCountBefore)
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'logs-run-123',
        level: 'info',
        message: 'Starting import',
        data: null,
      })
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'logs-run-123',
        level: 'warn',
        message: 'Skipping invalid row',
        data: { row: 5 },
      })
    })

    await waitFor(() => {
      expect(result.current.logs.length).toBe(2)
      expect(result.current.logs[0].level).toBe('info')
      expect(result.current.logs[1].level).toBe('warn')
    })
  })

  it('useLogs respects maxLogs option', async () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() =>
      hooks.useLogs('max-logs-run', { maxLogs: 2 }),
    )

    await waitFor(() => {
      expect(mockEventSource.instances.length).toBeGreaterThan(instanceCountBefore)
    })

    // Emit 3 logs
    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'max-logs-run',
        level: 'info',
        message: 'Log 1',
        data: null,
      })
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'max-logs-run',
        level: 'info',
        message: 'Log 2',
        data: null,
      })
    })

    act(() => {
      mockEventSource.emit({
        type: 'log:write',
        runId: 'max-logs-run',
        level: 'info',
        message: 'Log 3',
        data: null,
      })
    })

    await waitFor(() => {
      // Should only keep last 2 logs due to maxLogs: 2
      expect(result.current.logs.length).toBe(2)
      expect(result.current.logs[0].message).toBe('Log 2')
      expect(result.current.logs[1].message).toBe('Log 3')
    })
  })

  it('useRun with null runId does not subscribe', async () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => hooks.useRun(null))

    await new Promise((r) => setTimeout(r, 50))
    expect(mockEventSource.instances.length).toBe(instanceCountBefore)
    expect(result.current.status).toBeNull()
  })

  it('useLogs with null runId does not subscribe', async () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const instanceCountBefore = mockEventSource.instances.length
    const { result } = renderHook(() => hooks.useLogs(null))

    await new Promise((r) => setTimeout(r, 50))
    expect(mockEventSource.instances.length).toBe(instanceCountBefore)
    expect(result.current.logs).toEqual([])
  })
})
