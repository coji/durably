/**
 * createJobHooks Tests
 *
 * Test the type-safe job hooks factory.
 * Note: Hook behavior (SSE subscription, logs, progress, etc.) is tested in the individual hook tests.
 * These tests focus on the factory returning correctly configured hooks.
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

  it('forwards optional useJob options to the underlying hook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'csv-run-id' }),
    })
    globalThis.fetch = fetchMock

    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    // autoResume: false prevents the auto-fetch on mount;
    // if it were true, fetch would be called immediately.
    const { result } = renderHook(() =>
      hooks.useJob({ followLatest: false, autoResume: false }),
    )

    expect(result.current.trigger).toBeTypeOf('function')
    // autoResume: false means no fetch calls on mount
    expect(fetchMock).not.toHaveBeenCalled()
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
  })

  it('useLogs returns a hook function', () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    const { result } = renderHook(() => hooks.useLogs(null))

    // Verify the hook returns expected shape
    expect(result.current.logs).toEqual([])
  })

  describe('useRun callbacks', () => {
    const hooks = createJobHooks<typeof importCsvJob>({
      api: '/api/durably',
      jobName: 'import-csv',
    })

    it('works without options', async () => {
      const { result } = renderHook(() => hooks.useRun('no-opts-run'))

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:complete',
          runId: 'no-opts-run',
          output: { rowCount: 1, errors: 0 },
        })
      })

      await waitFor(() => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ rowCount: 1, errors: 0 })
      })
    })

    it('fires onComplete once when run completes via SSE run:complete', async () => {
      const onComplete = vi.fn()

      const { result } = renderHook(() =>
        hooks.useRun('complete-hooks-run', { onComplete }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:complete',
          runId: 'complete-hooks-run',
          output: { rowCount: 1, errors: 0 },
        })
      })

      await waitFor(() => {
        expect(result.current.isCompleted).toBe(true)
      })

      expect(onComplete).toHaveBeenCalledTimes(1)
    })

    it('fires onFail once when run fails via SSE run:fail', async () => {
      const onFail = vi.fn()

      const { result } = renderHook(() =>
        hooks.useRun('fail-hooks-run', { onFail }),
      )

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:fail',
          runId: 'fail-hooks-run',
          error: 'import failed',
        })
      })

      await waitFor(() => {
        expect(result.current.isFailed).toBe(true)
      })

      expect(onFail).toHaveBeenCalledTimes(1)
    })

    it('fires onStart once when transitioning from null to pending then leased', async () => {
      const onStart = vi.fn()

      const { result } = renderHook(() =>
        hooks.useRun('start-hooks-run', { onStart }),
      )

      await waitFor(() => {
        expect(result.current.status).toBe('pending')
      })

      expect(onStart).toHaveBeenCalledTimes(1)

      await waitFor(() => {
        expect(mockEventSource.instances.length).toBeGreaterThan(0)
      })

      act(() => {
        mockEventSource.emit({
          type: 'run:leased',
          runId: 'start-hooks-run',
        })
      })

      await waitFor(() => {
        expect(result.current.status).toBe('leased')
      })

      expect(onStart).toHaveBeenCalledTimes(1)
    })

    it.each([
      {
        label: 'onComplete after completion',
        runId: 'rerender-complete-run',
        callbackKey: 'onComplete' as const,
        sseEvent: {
          type: 'run:complete' as const,
          runId: 'rerender-complete-run',
          output: { rowCount: 1, errors: 0 },
        },
        isFinal: (r: ReturnType<typeof hooks.useRun>) => r.isCompleted,
      },
      {
        label: 'onFail after failure',
        runId: 'rerender-fail-run',
        callbackKey: 'onFail' as const,
        sseEvent: {
          type: 'run:fail' as const,
          runId: 'rerender-fail-run',
          error: 'failed',
        },
        isFinal: (r: ReturnType<typeof hooks.useRun>) => r.isFailed,
      },
    ])(
      'does not refire $label on rerender',
      async ({ runId, callbackKey, sseEvent, isFinal }) => {
        const cb = vi.fn()

        const { rerender, result } = renderHook(() =>
          hooks.useRun(runId, { [callbackKey]: cb }),
        )

        await waitFor(() => {
          expect(mockEventSource.instances.length).toBeGreaterThan(0)
        })

        act(() => {
          mockEventSource.emit(sseEvent)
        })

        await waitFor(() => {
          expect(isFinal(result.current)).toBe(true)
        })

        expect(cb).toHaveBeenCalledTimes(1)

        rerender()

        expect(cb).toHaveBeenCalledTimes(1)
      },
    )
  })
})
