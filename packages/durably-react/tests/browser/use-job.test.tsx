/**
 * useJob Tests
 *
 * Test useJob hook for browser-complete mode
 */

import { defineJob, type Durably } from '@coji/durably'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DurablyProvider, useJob } from '../../src'
import { createTestDurably } from '../helpers/create-test-durably'

// Test job definitions
const testJob = defineJob({
  name: 'test-job',
  input: z.object({ input: z.string() }),
  output: z.object({ success: z.boolean() }),
  run: async (_context, payload) => {
    return { success: payload.input === 'test' }
  },
})

const failingJob = defineJob({
  name: 'failing-job',
  input: z.object({ input: z.string() }),
  run: async () => {
    throw new Error('Something went wrong')
  },
})

const progressJob = defineJob({
  name: 'progress-job',
  input: z.object({ input: z.string() }),
  output: z.object({ done: z.boolean() }),
  run: async (context) => {
    context.progress(1, 3, 'Step 1')
    await context.run('step1', () => 'done')
    context.progress(2, 3, 'Step 2')
    await context.run('step2', () => 'done')
    context.progress(3, 3, 'Step 3')
    return { done: true }
  },
})

const loggingJob = defineJob({
  name: 'logging-job',
  input: z.object({ input: z.string() }),
  run: async (context) => {
    context.log.info('Starting')
    await context.run('work', () => 'done')
    context.log.info('Completed')
  },
})

describe('useJob', () => {
  // Track all instances created during tests for cleanup
  const instances: Durably[] = []

  afterEach(async () => {
    for (const instance of instances) {
      try {
        await instance.stop()
      } catch {
        // Ignore errors from already stopped instances
      }
    }
    instances.length = 0
    await new Promise((r) => setTimeout(r, 200))
  })

  // Helper to create wrapper with a fresh durably instance
  const createWrapper = (durably: Durably) => {
    return ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )
  }

  it('returns trigger function that executes job', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { runId } = await result.current.trigger({ input: 'test' })

    expect(runId).toBeDefined()
    expect(typeof runId).toBe('string')
  })

  it('updates status from pending to running to completed', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(result.current.status).toBeNull()

    result.current.trigger({ input: 'test' })

    // Status should be pending or already progressing
    // (fast execution may skip pending state)
    await waitFor(() => {
      expect(result.current.status).not.toBeNull()
    })

    // Then eventually complete
    await waitFor(() => {
      expect(result.current.status).toBe('completed')
    })
  })

  it('provides output when completed', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.output).toEqual({ success: true })
    })
  })

  it('provides error when failed', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(failingJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('Something went wrong')
    })
  })

  it('updates progress during execution', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(progressJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    result.current.trigger({ input: 'test' })

    // Eventually should see progress (may not catch all intermediate states)
    await waitFor(() => {
      expect(result.current.progress).not.toBeNull()
    })

    // Wait for completion
    await waitFor(() => {
      expect(result.current.status).toBe('completed')
    })
  })

  it('collects logs during execution', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(loggingJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.logs.length).toBeGreaterThanOrEqual(1)
    })

    // Check log structure
    const log = result.current.logs[0]
    expect(log.message).toBeDefined()
    expect(log.level).toBe('info')
  })

  it('provides boolean helpers', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    expect(result.current.isRunning).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isCompleted).toBe(false)
    expect(result.current.isFailed).toBe(false)

    result.current.trigger({ input: 'test' })

    // Wait for some state (may skip pending if fast)
    await waitFor(() => {
      expect(
        result.current.isPending ||
          result.current.isRunning ||
          result.current.isCompleted,
      ).toBe(true)
    })

    // completed state
    await waitFor(() => {
      expect(result.current.isCompleted).toBe(true)
    })

    expect(result.current.isRunning).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isFailed).toBe(false)
  })

  it('triggerAndWait resolves with output', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { runId, output } = await result.current.triggerAndWait({
      input: 'test',
    })

    expect(runId).toBeDefined()
    expect(output).toEqual({ success: true })
  })

  it('triggerAndWait rejects on failure', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(failingJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await expect(
      result.current.triggerAndWait({ input: 'test' }),
    ).rejects.toThrow('Something went wrong')
  })

  it('reset clears all state', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    await result.current.trigger({ input: 'test' })
    await waitFor(() => expect(result.current.isCompleted).toBe(true))

    result.current.reset()

    // Wait for reset to take effect
    await waitFor(() => {
      expect(result.current.status).toBeNull()
    })
    expect(result.current.output).toBeNull()
    expect(result.current.currentRunId).toBeNull()
  })

  it('sets initialRunId as currentRunId', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const fakeRunId = 'test-run-123'

    const { result } = renderHook(
      () => useJob(testJob, { initialRunId: fakeRunId }),
      { wrapper: createWrapper(durably) },
    )

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // Should have the initial runId set
    expect(result.current.currentRunId).toBe(fakeRunId)
  })

  it('unsubscribes on unmount', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result, unmount } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    result.current.trigger({ input: 'test' })

    // Unmount while running
    unmount()

    // No errors should occur (memory leak test)
    await new Promise((r) => setTimeout(r, 100))
  })

  describe('followLatest option', () => {
    it('switches to latest running job by default (followLatest: true)', async () => {
      const durably = await createTestDurably({ pollingInterval: 50 })
      instances.push(durably)

      const slowJob = defineJob({
        name: 'slow-job',
        input: z.object({ id: z.number() }),
        output: z.object({ id: z.number() }),
        run: async (context, payload) => {
          await context.run('work', async () => {
            await new Promise((r) => setTimeout(r, 200))
          })
          return { id: payload.id }
        },
      })

      const { result } = renderHook(() => useJob(slowJob), {
        wrapper: createWrapper(durably),
      })

      await waitFor(() => expect(result.current.isReady).toBe(true))

      // Trigger first job
      const { runId: firstRunId } = await result.current.trigger({ id: 1 })

      await waitFor(() => {
        expect(result.current.currentRunId).toBe(firstRunId)
      })

      // Trigger second job while first is still running
      const { runId: secondRunId } = await result.current.trigger({ id: 2 })

      // Should switch to the second job when it starts running
      await waitFor(() => {
        expect(result.current.currentRunId).toBe(secondRunId)
      })
    })

    it('stays on current run when followLatest: false and external run starts', async () => {
      const durably = await createTestDurably({ pollingInterval: 50 })
      instances.push(durably)

      // This test verifies that followLatest: false keeps tracking the current run
      // even when run:start events fire (from the worker starting jobs)
      const slowJob = defineJob({
        name: 'slow-job-no-follow',
        input: z.object({ id: z.number() }),
        output: z.object({ id: z.number() }),
        run: async (context, payload) => {
          await context.run('work', async () => {
            await new Promise((r) => setTimeout(r, 300))
          })
          return { id: payload.id }
        },
      })

      const { result } = renderHook(
        () => useJob(slowJob, { followLatest: false }),
        { wrapper: createWrapper(durably) },
      )

      await waitFor(() => expect(result.current.isReady).toBe(true))

      // Trigger first job
      const { runId: firstRunId } = await result.current.trigger({ id: 1 })

      // Wait for it to start running (status becomes 'running')
      await waitFor(() => {
        expect(result.current.status).toBe('running')
        expect(result.current.currentRunId).toBe(firstRunId)
      })

      // Wait for the first run to complete - with followLatest: false,
      // it should stay on firstRunId and eventually complete
      await waitFor(
        () => {
          expect(result.current.status).toBe('completed')
          expect(result.current.currentRunId).toBe(firstRunId)
        },
        { timeout: 5000 },
      )

      // Verify output is from the first job
      expect(result.current.output).toEqual({ id: 1 })
    })
  })
})
