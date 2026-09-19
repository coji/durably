/**
 * useJob Tests
 *
 * Test useJob hook for browser-complete mode
 */

import { defineJob, type Durably } from '@coji/durably'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { DurablyProvider, useJob } from '../../src/spa'
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

const longRunningJob = defineJob({
  name: 'long-running-job',
  input: z.object({ input: z.string() }),
  output: z.object({ done: z.boolean() }),
  run: async (context) => {
    // Simulate a long-running job by waiting
    await context.run('wait', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000))
    })
    return { done: true }
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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    const { runId } = await result.current.trigger({ input: 'test' })

    expect(runId).toBeDefined()
    expect(typeof runId).toBe('string')
  })

  it('updates status from pending to running to completed', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.output).toEqual({ success: true })
    })
  })

  it('provides error when failed', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(failingJob), {
      wrapper: createWrapper(durably),
    })

    await result.current.trigger({ input: 'test' })

    await waitFor(() => {
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('Something went wrong')
    })
  })

  it('updates progress during execution', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(progressJob), {
      wrapper: createWrapper(durably),
    })

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(loggingJob), {
      wrapper: createWrapper(durably),
    })

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    expect(result.current.isLeased).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isCompleted).toBe(false)
    expect(result.current.isFailed).toBe(false)
    expect(result.current.isTerminal).toBe(false)
    expect(result.current.isActive).toBe(false)

    result.current.trigger({ input: 'test' })

    // Wait for some state (may skip pending if fast)
    await waitFor(() => {
      expect(
        result.current.isPending ||
          result.current.isLeased ||
          result.current.isCompleted,
      ).toBe(true)
    })

    // completed state
    await waitFor(() => {
      expect(result.current.isCompleted).toBe(true)
    })

    expect(result.current.isLeased).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isFailed).toBe(false)
    expect(result.current.isTerminal).toBe(true)
    expect(result.current.isActive).toBe(false)
  })

  it('triggerAndWait resolves with output', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    const { runId, output } = await result.current.triggerAndWait({
      input: 'test',
    })

    expect(runId).toBeDefined()
    expect(output).toEqual({ success: true })
  })

  it('triggerAndWait rejects on failure', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(failingJob), {
      wrapper: createWrapper(durably),
    })

    await expect(
      result.current.triggerAndWait({ input: 'test' }),
    ).rejects.toThrow('Something went wrong')
  })

  it('reset clears all state', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const fakeRunId = 'test-run-123'

    const { result } = renderHook(
      () => useJob(testJob, { initialRunId: fakeRunId }),
      { wrapper: createWrapper(durably) },
    )

    // Should have the initial runId set
    expect(result.current.currentRunId).toBe(fakeRunId)
  })

  it('unsubscribes on unmount', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result, unmount } = renderHook(() => useJob(testJob), {
      wrapper: createWrapper(durably),
    })

    result.current.trigger({ input: 'test' })

    // Unmount while running
    unmount()

    // No errors should occur (memory leak test)
    await new Promise((r) => setTimeout(r, 100))
  })

  describe('followLatest option', () => {
    it('switches to latest running job by default (followLatest: true)', async () => {
      const durably = await createTestDurably({ pollingIntervalMs: 50 })
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
      const durably = await createTestDurably({ pollingIntervalMs: 50 })
      instances.push(durably)

      // This test verifies that followLatest: false keeps tracking the current run
      // even when run:leased events fire (from the worker starting jobs)
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

      // Trigger first job
      const { runId: firstRunId } = await result.current.trigger({ id: 1 })

      // Wait for it to be leased (status becomes 'leased')
      await waitFor(() => {
        expect(result.current.status).toBe('leased')
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

  it('triggerAndWait rejects on cancelled', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJob(longRunningJob), {
      wrapper: createWrapper(durably),
    })

    // Start the long-running job and get the promise
    const waitPromise = result.current.triggerAndWait({ input: 'test' })

    // Wait for the job to start running
    await waitFor(() => {
      expect(result.current.currentRunId).not.toBeNull()
      expect(result.current.status).toBe('leased')
    })

    // Cancel the job
    const runId = result.current.currentRunId!
    await durably.cancel(runId)

    // The promise should reject with 'Job cancelled'
    await expect(waitPromise).rejects.toThrow('Job cancelled')
  })

  describe('scoped tracking', () => {
    it('auto-resumes only a run matching every scope label and hydrates pending status', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      await handle.trigger(
        { input: 'wrong' },
        { labels: { documentId: 'other', tenant: 'acme' } },
      )
      const matching = await handle.trigger(
        { input: 'test' },
        { labels: { documentId: 'doc-1', tenant: 'acme' } },
      )

      const { result } = renderHook(
        () =>
          useJob(testJob, {
            followLatest: false,
            scope: { labels: { documentId: 'doc-1', tenant: 'acme' } },
          }),
        { wrapper: createWrapper(durably) },
      )

      expect(result.current.isResolving).toBe(true)
      await waitFor(() => {
        expect(result.current.isResolving).toBe(false)
        expect(result.current.currentRunId).toBe(matching.id)
        expect(result.current.status).toBe('pending')
      })
    })

    it('follows matching pending triggers immediately and ignores non-matching labels', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const { result } = renderHook(
        () =>
          useJob(testJob, {
            autoResume: false,
            scope: { labels: { documentId: 'doc-2' } },
          }),
        { wrapper: createWrapper(durably) },
      )

      const wrong = await handle.trigger(
        { input: 'wrong' },
        { labels: { documentId: 'other' } },
      )
      expect(result.current.currentRunId).not.toBe(wrong.id)

      const matching = await handle.trigger(
        { input: 'test' },
        { labels: { documentId: 'doc-2' } },
      )
      await waitFor(() => {
        expect(result.current.currentRunId).toBe(matching.id)
        expect(result.current.status).toBe('pending')
      })
    })

    it('preserves progress and logs when a follow event refers to the current run', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const { result } = renderHook(
        () => useJob(testJob, { autoResume: false }),
        { wrapper: createWrapper(durably) },
      )

      act(() => {
        durably.emit({
          type: 'run:trigger',
          runId: 'same-run',
          jobName: testJob.name,
          input: { input: 'test' },
          labels: {},
        })
        durably.emit({
          type: 'run:progress',
          runId: 'same-run',
          jobName: testJob.name,
          progress: { current: 1, total: 2 },
          labels: {},
        })
        durably.emit({
          type: 'log:write',
          runId: 'same-run',
          jobName: testJob.name,
          labels: {},
          stepName: null,
          level: 'info',
          message: 'still here',
          data: null,
        })
      })
      await waitFor(() => {
        expect(result.current.progress).toEqual({ current: 1, total: 2 })
        expect(result.current.logs).toHaveLength(1)
      })

      act(() => {
        durably.emit({
          type: 'run:coalesced',
          runId: 'same-run',
          jobName: testJob.name,
          status: 'leased',
          labels: {},
          skippedInput: { input: 'duplicate' },
          skippedLabels: {},
        })
        durably.emit({
          type: 'run:leased',
          runId: 'same-run',
          jobName: testJob.name,
          input: { input: 'test' },
          leaseOwner: 'worker-1',
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          labels: {},
        })
      })

      expect(result.current.status).toBe('leased')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      expect(result.current.logs.map((log) => log.message)).toEqual([
        'still here',
      ])

      // Lease recovery can return this same run to pending before an active
      // trigger coalesces it again. The status changes without a new run ID.
      act(() => {
        durably.emit({
          type: 'run:coalesced',
          runId: 'same-run',
          jobName: testJob.name,
          status: 'pending',
          labels: {},
          skippedInput: { input: 'duplicate' },
          skippedLabels: {},
        })
      })
      expect(result.current.status).toBe('pending')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      expect(result.current.logs.map((log) => log.message)).toEqual([
        'still here',
      ])

      act(() => {
        durably.emit({
          type: 'run:complete',
          runId: 'same-run',
          jobName: testJob.name,
          output: { success: true },
          duration: 1,
          labels: {},
        })
        durably.emit({
          type: 'run:coalesced',
          runId: 'same-run',
          jobName: testJob.name,
          status: 'leased',
          labels: {},
          skippedInput: { input: 'duplicate' },
          skippedLabels: {},
        })
      })
      expect(result.current.status).toBe('completed')
    })

    it('scope changes discard prior state and resolve the new scope', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const first = await handle.trigger(
        { input: 'first' },
        { labels: { documentId: 'doc-a' } },
      )
      const second = await handle.trigger(
        { input: 'second' },
        { labels: { documentId: 'doc-b' } },
      )

      const { result, rerender } = renderHook(
        ({ documentId }) =>
          useJob(testJob, { scope: { labels: { documentId } } }),
        {
          initialProps: { documentId: 'doc-a' },
          wrapper: createWrapper(durably),
        },
      )
      await waitFor(() => expect(result.current.currentRunId).toBe(first.id))

      rerender({ documentId: 'doc-b' })
      await waitFor(() => {
        expect(result.current.isResolving).toBe(false)
        expect(result.current.currentRunId).toBe(second.id)
      })
    })

    it('explicit initialRunId skips scoped lookup and hydrates its status', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const initial = await handle.trigger(
        { input: 'test' },
        { labels: { documentId: 'explicit' } },
      )
      const getRuns = vi.spyOn(durably.storage, 'getRuns')

      const { result } = renderHook(
        () =>
          useJob(testJob, {
            initialRunId: initial.id,
            scope: { labels: { documentId: 'other' } },
          }),
        { wrapper: createWrapper(durably) },
      )

      await waitFor(() => {
        expect(result.current.currentRunId).toBe(initial.id)
        expect(result.current.status).toBe('pending')
        expect(result.current.isResolving).toBe(false)
      })
      expect(getRuns).not.toHaveBeenCalled()

      act(() => {
        durably.emit({
          type: 'run:leased',
          runId: initial.id,
          jobName: testJob.name,
          input: { input: 'test' },
          leaseOwner: 'worker-1',
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          labels: { documentId: 'explicit' },
        })
      })
      expect(result.current.status).toBe('leased')
      expect(result.current.isLeased).toBe(true)
    })

    it('forwards triggerOptions and keeps explicit triggers tracked when followLatest is false', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const { result } = renderHook(
        () =>
          useJob(testJob, {
            autoResume: false,
            followLatest: false,
            triggerOptions: {
              concurrencyKey: 'document:doc-3',
              idempotencyKey: 'request-3',
              labels: { documentId: 'doc-3' },
              coalesce: 'active',
            },
          }),
        { wrapper: createWrapper(durably) },
      )

      const { runId } = await result.current.trigger({ input: 'test' })
      const run = await durably.getRun(runId)
      expect(result.current.currentRunId).toBe(runId)
      expect(run).toMatchObject({
        concurrencyKey: 'document:doc-3',
        idempotencyKey: 'request-3',
        labels: { documentId: 'doc-3' },
      })
    })

    it('applies triggerOptions to triggerAndWait', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const { result } = renderHook(
        () =>
          useJob(testJob, {
            autoResume: false,
            triggerOptions: {
              concurrencyKey: 'document:wait',
              labels: { documentId: 'wait' },
              coalesce: 'active',
            },
          }),
        { wrapper: createWrapper(durably) },
      )

      const waiting = result.current.triggerAndWait({ input: 'test' })
      await waitFor(() => expect(result.current.currentRunId).not.toBeNull())
      await durably.processUntilIdle()
      const { runId, output } = await waiting
      expect(output).toEqual({ success: true })
      expect(await durably.getRun(runId)).toMatchObject({
        concurrencyKey: 'document:wait',
        labels: { documentId: 'wait' },
      })
    })

    it('ignores a trigger result after initialRunId changes', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const old = await handle.trigger({ input: 'old' })
      const newer = await handle.trigger({ input: 'newer' })
      let resolveTrigger!: (run: typeof old) => void
      const delayed = new Promise<typeof old>((resolve) => {
        resolveTrigger = resolve
      })
      vi.spyOn(handle, 'trigger').mockReturnValueOnce(delayed)

      const { result, rerender } = renderHook(
        ({ initialRunId }: { initialRunId?: string }) =>
          useJob(testJob, {
            autoResume: false,
            followLatest: false,
            initialRunId,
          }),
        {
          wrapper: createWrapper(durably),
          initialProps: { initialRunId: undefined as string | undefined },
        },
      )

      const pending = result.current.trigger({ input: 'old' })
      rerender({ initialRunId: newer.id })
      await waitFor(() => expect(result.current.currentRunId).toBe(newer.id))

      await act(async () => resolveTrigger(old))
      await expect(pending).resolves.toEqual({ runId: old.id })
      expect(result.current.currentRunId).toBe(newer.id)
    })

    it('revalidates a reused trigger result after installing its run ID', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const stale = await handle.trigger({ input: 'test' })
      await durably.processUntilIdle()
      expect((await durably.getRun(stale.id))?.status).toBe('completed')
      vi.spyOn(handle, 'trigger').mockResolvedValueOnce(stale)

      const { result } = renderHook(
        () => useJob(testJob, { autoResume: false, followLatest: false }),
        { wrapper: createWrapper(durably) },
      )

      await result.current.trigger({ input: 'test' })
      await waitFor(() => {
        expect(result.current.currentRunId).toBe(stale.id)
        expect(result.current.status).toBe('completed')
      })
      expect(result.current.output).toEqual({ success: true })
    })

    it('a matching follow event wins over an older in-flight lookup', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      let resolveLookup!: (
        runs: Awaited<ReturnType<typeof durably.storage.getRuns>>,
      ) => void
      const lookup = new Promise<
        Awaited<ReturnType<typeof durably.storage.getRuns>>
      >((resolve) => {
        resolveLookup = resolve
      })
      const getRuns = vi.spyOn(durably.storage, 'getRuns')
      getRuns.mockImplementationOnce(() => lookup)

      const { result } = renderHook(
        () =>
          useJob(testJob, { scope: { labels: { documentId: 'doc-race' } } }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => expect(getRuns).toHaveBeenCalled())

      const newer = await handle.trigger(
        { input: 'newer' },
        { labels: { documentId: 'doc-race' } },
      )
      await waitFor(() => expect(result.current.currentRunId).toBe(newer.id))

      await act(async () => resolveLookup([]))
      expect(result.current.currentRunId).toBe(newer.id)
      expect(result.current.isResolving).toBe(false)
    })

    it('re-reads after installing an auto-resumed run to catch a missed terminal event', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const pending = await handle.trigger(
        { input: 'test' },
        { labels: { documentId: 'terminal-race' } },
      )
      const terminal = {
        ...pending,
        status: 'completed' as const,
        output: { success: true },
      }
      const getRun = vi.spyOn(durably.storage, 'getRun')
      getRun
        .mockImplementationOnce(async () => {
          durably.emit({
            type: 'run:complete',
            runId: pending.id,
            jobName: testJob.name,
            output: { success: true },
            duration: 1,
            labels: { documentId: 'terminal-race' },
          })
          return pending
        })
        .mockResolvedValueOnce(terminal)

      const { result } = renderHook(
        () =>
          useJob(testJob, {
            followLatest: false,
            scope: { labels: { documentId: 'terminal-race' } },
          }),
        { wrapper: createWrapper(durably) },
      )

      await waitFor(() => {
        expect(result.current.isResolving).toBe(false)
        expect(result.current.currentRunId).toBe(pending.id)
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ success: true })
      })
      expect(getRun).toHaveBeenCalledTimes(2)
    })

    it('an old scope lookup rejection does not finish the new scope lookup', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      let rejectOld!: (error: Error) => void
      let resolveCurrent!: (
        runs: Awaited<ReturnType<typeof durably.storage.getRuns>>,
      ) => void
      const oldLookup = new Promise<
        Awaited<ReturnType<typeof durably.storage.getRuns>>
      >((_resolve, reject) => {
        rejectOld = reject
      })
      const currentLookup = new Promise<
        Awaited<ReturnType<typeof durably.storage.getRuns>>
      >((resolve) => {
        resolveCurrent = resolve
      })
      const getRuns = vi.spyOn(durably.storage, 'getRuns')
      getRuns
        .mockImplementationOnce(() => oldLookup)
        .mockImplementationOnce(() => currentLookup)

      const { result, rerender } = renderHook(
        ({ documentId }) =>
          useJob(testJob, { scope: { labels: { documentId } } }),
        {
          initialProps: { documentId: 'old' },
          wrapper: createWrapper(durably),
        },
      )
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(1))

      rerender({ documentId: 'current' })
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(2))
      await act(async () => rejectOld(new Error('old lookup failed')))
      expect(result.current.isResolving).toBe(true)

      await act(async () => resolveCurrent([]))
      await waitFor(() => expect(result.current.isResolving).toBe(false))
    })

    it('inline scope and trigger option objects do not repeat lookups', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const getRuns = vi.spyOn(durably.storage, 'getRuns')
      const { rerender } = renderHook(
        () =>
          useJob(testJob, {
            followLatest: false,
            scope: { labels: { documentId: 'stable' } },
            triggerOptions: {
              labels: { documentId: 'stable' },
              concurrencyKey: 'document:stable',
              coalesce: 'active',
            },
          }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(2))
      rerender()
      await act(async () => Promise.resolve())
      expect(getRuns).toHaveBeenCalledTimes(2)
    })

    it('reordered but equal label records do not repeat lookups', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const getRuns = vi.spyOn(durably.storage, 'getRuns')
      const { rerender } = renderHook(
        ({ reverse }) => {
          const labels = reverse
            ? { tenant: 'acme', documentId: 'stable' }
            : { documentId: 'stable', tenant: 'acme' }
          return useJob(testJob, {
            followLatest: false,
            scope: { labels },
            triggerOptions: { labels },
          })
        },
        {
          initialProps: { reverse: false },
          wrapper: createWrapper(durably),
        },
      )
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(2))
      rerender({ reverse: true })
      await act(async () => Promise.resolve())
      expect(getRuns).toHaveBeenCalledTimes(2)
    })
  })
})
