/**
 * createJobHooks Tests
 *
 * Test the type-safe job hooks factory.
 * Note: Hook behavior (SSE subscription, logs, progress, etc.) is tested in the individual hook tests.
 * These tests focus on the factory returning correctly configured hooks.
 */

import { defineJob } from '@coji/durably'
import { renderHook } from '@testing-library/react'
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

  it('useJob uses the configured jobName', async () => {
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
    await result.current.trigger({ filename: 'data.csv' })

    // Verify the configured jobName is used
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/durably/trigger',
      expect.objectContaining({
        body: JSON.stringify({
          jobName: 'import-csv',
          input: { filename: 'data.csv' },
        }),
      }),
    )
  })

  it('useJob uses the configured api endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'run-id' }),
    })
    globalThis.fetch = fetchMock

    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/custom/api/path',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useJob())
    await result.current.trigger({ filename: 'test.csv' })

    // Verify the configured api endpoint is used
    expect(fetchMock).toHaveBeenCalledWith(
      '/custom/api/path/trigger',
      expect.anything(),
    )
  })

  it('useRun returns a hook function', () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useRun(null))

    // Verify the hook returns expected shape
    expect(result.current.status).toBeNull()
    expect(result.current.isReady).toBe(true)
  })

  it('useLogs returns a hook function', () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useLogs(null))

    // Verify the hook returns expected shape
    expect(result.current.logs).toEqual([])
    expect(result.current.isReady).toBe(true)
  })
})
