/**
 * useJob Tests
 *
 * Test useJob hook for browser-complete mode
 */

import { defineJob, type Durably } from '@coji/durably'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import {
  Suspense,
  startTransition,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react'
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
    // Stay running until cancelled, so the test cannot race the job's end
    await context.run('wait', async (signal) => {
      if (signal.aborted) return
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
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
    // sleep-ok(yield): settles leftover async work after stop(); every test
    // uses its own database, so nothing depends on how long this is.
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
    // sleep-ok(negative): gives a late event a chance to reach the unmounted
    // hook; a slow machine can only hide an error, not cause one.
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
            // sleep-ok(work): the second run is followed once it is leased,
            // whether or not the first run is still running by then.
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
      // The run holds here until the test has observed it leased
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const slowJob = defineJob({
        name: 'slow-job-no-follow',
        input: z.object({ id: z.number() }),
        output: z.object({ id: z.number() }),
        run: async (context, payload) => {
          await context.run('work', async () => {
            await released
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
      try {
        await waitFor(
          () => {
            expect(result.current.status).toBe('leased')
            expect(result.current.currentRunId).toBe(firstRunId)
          },
          { timeout: 5000 },
        )
      } finally {
        // stop() waits for the run, so release it even if the wait failed
        release()
      }

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
    // Observe rejection before asynchronous cancellation/cleanup can settle it.
    const rejected = expect(waitPromise).rejects.toThrow('Job cancelled')

    // Wait for the job to start running
    try {
      await waitFor(
        () => {
          expect(result.current.currentRunId).not.toBeNull()
          expect(result.current.status).toBe('leased')
        },
        { timeout: 5000 },
      )
    } finally {
      // Cancel the job. It runs until cancelled and stop() waits for it, so
      // cancel even if the wait failed.
      const runId = result.current.currentRunId
      if (runId) await durably.cancel(runId)
    }

    // The promise should reject with 'Job cancelled'
    await rejected
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

    it('restores a scoped waiting run only after finding no leased or pending run', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const run = await handle.trigger(
        { input: 'test' },
        { labels: { documentId: 'doc-2' } },
      )
      const waitingRun = {
        ...(await handle.getRun(run.id)),
        status: 'waiting' as const,
      }
      const getRuns = vi
        .spyOn(durably.storage, 'getRuns')
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          waitingRun as NonNullable<Awaited<ReturnType<typeof handle.getRun>>>,
        ])
      vi.spyOn(durably.storage, 'getRun').mockResolvedValue(
        waitingRun as NonNullable<Awaited<ReturnType<typeof handle.getRun>>>,
      )
      const { result } = renderHook(
        () =>
          useJob(testJob, {
            scope: { labels: { documentId: 'doc-2' } },
            followLatest: false,
          }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => expect(result.current.isWaiting).toBe(true))
      expect(result.current.currentRunId).toBe(run.id)
      expect(result.current.isResolving).toBe(false)
      expect(getRuns.mock.calls.map(([filter]) => filter?.status)).toEqual([
        'leased',
        'pending',
        'waiting',
      ])
      expect(
        getRuns.mock.calls.every(
          ([filter]) => filter?.labels?.documentId === 'doc-2',
        ),
      ).toBe(true)
    })

    it('follows scoped waiting events and preserves state through coalescing and resume', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      durably.register({ testJob })
      const { result } = renderHook(
        () =>
          useJob(testJob, {
            autoResume: false,
            scope: { labels: { documentId: 'doc-2' } },
          }),
        { wrapper: createWrapper(durably) },
      )
      act(() =>
        durably.emit({
          type: 'run:waiting',
          runId: 'wrong',
          jobName: testJob.name,
          waitId: 'wait-0',
          labels: { documentId: 'other' },
        }),
      )
      expect(result.current.currentRunId).toBeNull()
      act(() =>
        durably.emit({
          type: 'run:waiting',
          runId: 'waiting',
          jobName: testJob.name,
          waitId: 'wait-1',
          labels: { documentId: 'doc-2' },
        }),
      )
      expect(result.current.currentRunId).toBe('waiting')
      expect(result.current.isWaiting).toBe(true)
      expect(result.current.isActive).toBe(false)
      expect(result.current.isTerminal).toBe(false)
      act(() =>
        durably.emit({
          type: 'run:coalesced',
          runId: 'waiting',
          jobName: testJob.name,
          status: 'waiting',
          labels: { documentId: 'doc-2' },
          skippedInput: {},
          skippedLabels: {},
        }),
      )
      expect(result.current.isWaiting).toBe(true)
      act(() =>
        durably.emit({
          type: 'run:leased',
          runId: 'waiting',
          jobName: testJob.name,
          input: {},
          leaseOwner: 'worker',
          leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
          labels: { documentId: 'doc-2' },
        }),
      )
      expect(result.current.isWaiting).toBe(false)
      expect(result.current.isLeased).toBe(true)
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

    it('tracks a child effect trigger after a scope change with following disabled', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      let currentRunId: string | null = null
      let pending!: Promise<{ runId: string }>

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useEffect(() => {
          if (documentId === 'doc-b') {
            pending = trigger({ input: 'test' })
          }
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          autoResume: false,
          followLatest: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      const { runId } = await act(async () => pending)
      expect(await durably.getRun(runId)).not.toBeNull()
      expect(currentRunId).toBe(runId)
    })

    it('does not let scoped auto-resume replace a child effect trigger', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const older = await handle.trigger(
        { input: 'older' },
        { labels: { documentId: 'doc-b' } },
      )
      let currentRunId: string | null = null
      let pending!: Promise<{ runId: string }>

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useEffect(() => {
          if (documentId === 'doc-b') pending = trigger({ input: 'newer' })
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          followLatest: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      const { runId } = await act(async () => pending)
      expect(runId).not.toBe(older.id)
      await waitFor(() => expect(currentRunId).toBe(runId))
    })

    it('resumes an existing run when a child effect trigger fails', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const older = await handle.trigger(
        { input: 'older' },
        { labels: { documentId: 'doc-b' } },
      )
      let currentRunId: string | null = null
      let pending!: Promise<{ runId: string }>

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useEffect(() => {
          if (documentId === 'doc-b') {
            pending = trigger({ input: undefined as unknown as string })
          }
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          followLatest: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      await act(async () => {
        await expect(pending).rejects.toThrow()
      })
      await waitFor(() => expect(currentRunId).toBe(older.id))
    })

    it('discards an old-scope follow event during a scope change', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      let currentRunId: string | null = null

      function Child({ documentId }: { documentId: string }) {
        useLayoutEffect(() => {
          if (documentId === 'doc-b') {
            durably.emit({
              type: 'run:trigger',
              runId: 'old-scope-run',
              jobName: testJob.name,
              input: { input: 'test' },
              labels: { documentId: 'doc-a' },
            })
          }
        }, [documentId])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          autoResume: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      expect(currentRunId).toBeNull()
    })

    it('follows a new-scope event during the subscription handoff', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      let currentRunId: string | null = null

      function Child({ documentId }: { documentId: string }) {
        useLayoutEffect(() => {
          if (documentId === 'doc-b') {
            durably.emit({
              type: 'run:trigger',
              runId: 'new-scope-run',
              jobName: testJob.name,
              input: { input: 'test' },
              labels: { documentId: 'doc-b' },
            })
          }
        }, [documentId])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          autoResume: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      expect(currentRunId).toBe('new-scope-run')
    })

    it('keeps a new-scope follow ahead of a later auto-resume lookup', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const older = await handle.trigger(
        { input: 'older' },
        { labels: { documentId: 'doc-b' } },
      )
      const leased = await durably.storage.claimNext(
        'worker-1',
        new Date().toISOString(),
        30_000,
      )
      expect(leased?.id).toBe(older.id)
      const newer = await handle.trigger(
        { input: 'newer' },
        { labels: { documentId: 'doc-b' } },
      )
      const getRuns = vi.spyOn(durably.storage, 'getRuns')
      let currentRunId: string | null = null
      let isResolving = true

      function Child({ documentId }: { documentId: string }) {
        useLayoutEffect(() => {
          if (documentId === 'doc-b') {
            durably.emit({
              type: 'run:trigger',
              runId: newer.id,
              jobName: testJob.name,
              input: { input: 'newer' },
              labels: { documentId: 'doc-b' },
            })
          }
        }, [documentId])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, { scope: { labels: { documentId } } })
        currentRunId = job.currentRunId
        isResolving = job.isResolving
        return <Child documentId={documentId} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      await waitFor(() => expect(isResolving).toBe(false))
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      await waitFor(() =>
        expect(getRuns).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 'leased',
            labels: { documentId: 'doc-b' },
          }),
        ),
      )
      await waitFor(() => expect(isResolving).toBe(false))
      expect(currentRunId).toBe(newer.id)
    })

    it('tracks a child trigger when an old-scope event follows in the same layout effect', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      let currentRunId: string | null = null
      let pending!: Promise<{ runId: string }>

      function Child({
        documentId,
        trigger,
      }: {
        documentId: string
        trigger: (input: { input: string }) => Promise<{ runId: string }>
      }) {
        useLayoutEffect(() => {
          if (documentId !== 'doc-b') return
          pending = trigger({ input: 'new-scope' })
          durably.emit({
            type: 'run:trigger',
            runId: 'old-scope-run',
            jobName: testJob.name,
            input: { input: 'old-scope' },
            labels: { documentId: 'doc-a' },
          })
        }, [documentId, trigger])
        return null
      }

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          autoResume: false,
          scope: { labels: { documentId } },
        })
        currentRunId = job.currentRunId
        return <Child documentId={documentId} trigger={job.trigger} />
      }

      const { rerender } = render(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-a" />
        </DurablyProvider>,
      )
      rerender(
        <DurablyProvider durably={durably}>
          <Parent documentId="doc-b" />
        </DurablyProvider>,
      )
      const { runId } = await act(async () => pending)
      expect(currentRunId).toBe(runId)
    })

    it('keeps following the committed scope while another scope suspends', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const suspended = new Promise<void>(() => {})
      let changeScope!: () => void

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          autoResume: false,
          scope: { labels: { documentId } },
        })
        if (documentId === 'doc-b') throw suspended
        return (
          <output data-testid="tracked-run">
            {job.currentRunId ?? 'none'}
          </output>
        )
      }

      function Host() {
        const [documentId, setDocumentId] = useState('doc-a')
        changeScope = () => startTransition(() => setDocumentId('doc-b'))
        return <Parent documentId={documentId} />
      }

      const { getByTestId } = render(
        <DurablyProvider durably={durably}>
          <Suspense fallback={null}>
            <Host />
          </Suspense>
        </DurablyProvider>,
      )
      act(() => changeScope())
      expect(getByTestId('tracked-run').textContent).toBe('none')

      act(() => {
        durably.emit({
          type: 'run:trigger',
          runId: 'committed-scope-run',
          jobName: testJob.name,
          input: { input: 'test' },
          labels: { documentId: 'doc-a' },
        })
      })
      expect(getByTestId('tracked-run').textContent).toBe('committed-scope-run')
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

    it('hydrates a fixed run after a different-scope render suspends', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const run = await handle.trigger({ input: 'test' })
      await durably.processOne()
      const completed = await durably.getRun(run.id)
      expect(completed?.status).toBe('completed')
      let resolveFirstRead!: (value: typeof completed) => void
      vi.spyOn(durably.storage, 'getRun').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve
          }),
      )
      const suspended = new Promise<void>(() => {})
      let changeScope!: () => void

      function Parent({ documentId }: { documentId: string }) {
        const job = useJob(testJob, {
          initialRunId: run.id,
          scope: { labels: { documentId } },
        })
        if (documentId === 'doc-b') throw suspended
        return (
          <output data-testid="fixed-status">{job.status ?? 'none'}</output>
        )
      }

      function Host() {
        const [documentId, setDocumentId] = useState('doc-a')
        changeScope = () => startTransition(() => setDocumentId('doc-b'))
        return <Parent documentId={documentId} />
      }

      const { getByTestId } = render(
        <DurablyProvider durably={durably}>
          <Suspense fallback={null}>
            <Host />
          </Suspense>
        </DurablyProvider>,
      )
      await waitFor(() => expect(resolveFirstRead).toBeDefined())
      act(() => changeScope())
      expect(getByTestId('fixed-status').textContent).toBe('none')
      await act(async () => {
        resolveFirstRead(completed)
      })
      await waitFor(() =>
        expect(getByTestId('fixed-status').textContent).toBe('completed'),
      )
    })

    it('clears stale run state when initialRunId changes or is removed', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const first = await handle.trigger({ input: 'first' })
      const second = await handle.trigger({ input: 'second' })
      const { result, rerender } = renderHook(
        ({ initialRunId }: { initialRunId?: string }) =>
          useJob(testJob, { autoResume: false, initialRunId }),
        {
          wrapper: createWrapper(durably),
          initialProps: { initialRunId: first.id as string | undefined },
        },
      )
      await waitFor(() => expect(result.current.status).toBe('pending'))
      act(() => {
        durably.emit({
          type: 'run:progress',
          runId: first.id,
          jobName: testJob.name,
          progress: { current: 1, total: 2 },
          labels: {},
        })
      })
      expect(result.current.progress).toEqual({ current: 1, total: 2 })

      vi.spyOn(durably.storage, 'getRun').mockResolvedValueOnce(null)
      rerender({ initialRunId: second.id })
      await waitFor(() => expect(result.current.currentRunId).toBe(second.id))
      expect(result.current.status).toBeNull()
      expect(result.current.progress).toBeNull()
      expect(result.current.logs).toEqual([])

      rerender({ initialRunId: undefined })
      await waitFor(() => expect(result.current.currentRunId).toBeNull())
      expect(result.current.status).toBeNull()
    })

    it('does not let stale initialRunId hydration replace a terminal event', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const pending = await handle.trigger({ input: 'test' })
      vi.spyOn(durably.storage, 'getRun').mockImplementationOnce(async () => {
        durably.emit({
          type: 'run:complete',
          runId: pending.id,
          jobName: testJob.name,
          output: { success: true },
          duration: 1,
          labels: {},
        })
        return pending
      })
      const { result } = renderHook(
        () => useJob(testJob, { initialRunId: pending.id }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => {
        expect(result.current.currentRunId).toBe(pending.id)
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ success: true })
      })
    })

    it('keeps same-run progress and logs when initial hydration returns an older pending snapshot', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const pending = await handle.trigger({ input: 'test' })
      let resolveFirstRead!: (value: typeof pending) => void
      vi.spyOn(durably.storage, 'getRun').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve
          }),
      )
      const { result } = renderHook(
        () => useJob(testJob, { initialRunId: pending.id }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => expect(resolveFirstRead).toBeDefined())
      act(() => {
        durably.emit({
          type: 'run:leased',
          runId: pending.id,
          jobName: testJob.name,
          input: { input: 'test' },
          leaseOwner: 'worker-1',
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          labels: {},
        })
        durably.emit({
          type: 'run:progress',
          runId: pending.id,
          jobName: testJob.name,
          progress: { current: 1, total: 2 },
          labels: {},
        })
        durably.emit({
          type: 'log:write',
          runId: pending.id,
          jobName: testJob.name,
          labels: {},
          stepName: null,
          level: 'info',
          message: 'keep this',
          data: null,
        })
      })
      await act(async () => {
        resolveFirstRead(pending)
      })
      expect(result.current.status).toBe('leased')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      expect(result.current.logs.map((log) => log.message)).toEqual([
        'keep this',
      ])
    })

    it('keeps progress and logs received before hydrating an already leased initial run', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const pending = await handle.trigger({ input: 'test' })
      const leased = await durably.storage.claimNext(
        'worker-1',
        new Date().toISOString(),
        30_000,
      )
      expect(leased?.id).toBe(pending.id)
      let resolveFirstRead!: (value: typeof leased) => void
      vi.spyOn(durably.storage, 'getRun').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstRead = resolve
          }),
      )
      const { result } = renderHook(
        () => useJob(testJob, { initialRunId: pending.id }),
        { wrapper: createWrapper(durably) },
      )
      await waitFor(() => expect(resolveFirstRead).toBeDefined())
      act(() => {
        durably.emit({
          type: 'run:progress',
          runId: pending.id,
          jobName: testJob.name,
          progress: { current: 1, total: 2 },
          labels: {},
        })
        durably.emit({
          type: 'log:write',
          runId: pending.id,
          jobName: testJob.name,
          labels: {},
          stepName: null,
          level: 'info',
          message: 'before hydration',
          data: null,
        })
      })
      expect(result.current.status).toBeNull()
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      await act(async () => {
        resolveFirstRead(leased)
      })
      expect(result.current.status).toBe('leased')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      expect(result.current.logs.map((log) => log.message)).toEqual([
        'before hydration',
      ])
    })

    it('keeps a found run when auto-resume revalidation fails', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const pending = await handle.trigger({ input: 'test' })
      vi.spyOn(durably.storage, 'getRun').mockRejectedValueOnce(
        new Error('temporary read failure'),
      )
      const { result } = renderHook(() => useJob(testJob), {
        wrapper: createWrapper(durably),
      })
      await waitFor(() => {
        expect(result.current.isResolving).toBe(false)
        expect(result.current.currentRunId).toBe(pending.id)
        expect(result.current.status).toBe('pending')
      })
    })

    it('clears the previous provider run when Durably changes', async () => {
      const first = await createTestDurably({ autoStart: false })
      const second = await createTestDurably({ autoStart: false })
      instances.push(first, second)
      const provider = { current: first }
      const wrapper = ({ children }: { children: ReactNode }) => (
        <DurablyProvider durably={provider.current}>{children}</DurablyProvider>
      )
      const { result, rerender } = renderHook(
        () => useJob(testJob, { autoResume: false }),
        { wrapper },
      )
      const { runId } = await result.current.trigger({ input: 'test' })
      await waitFor(() => expect(result.current.currentRunId).toBe(runId))

      provider.current = second
      rerender()
      await waitFor(() => expect(result.current.currentRunId).toBeNull())
      expect(result.current.status).toBeNull()
      expect(result.current.progress).toBeNull()
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

    it('keeps a successful trigger result when revalidation fails', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      vi.spyOn(durably.storage, 'getRun').mockRejectedValueOnce(
        new Error('temporary read failure'),
      )
      const { result } = renderHook(
        () => useJob(testJob, { autoResume: false, followLatest: false }),
        { wrapper: createWrapper(durably) },
      )

      const { runId } = await result.current.trigger({ input: 'test' })
      await waitFor(() => expect(result.current.currentRunId).toBe(runId))
      expect((await durably.getRun(runId))?.status).toBe('pending')
    })

    it('clears resolving when reset supersedes an in-flight lookup', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      durably.register({ testJob })
      let resolveLookup!: (
        runs: Awaited<ReturnType<typeof durably.storage.getRuns>>,
      ) => void
      vi.spyOn(durably.storage, 'getRuns').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLookup = resolve
          }),
      )
      const { result } = renderHook(() => useJob(testJob), {
        wrapper: createWrapper(durably),
      })
      await waitFor(() => expect(result.current.isResolving).toBe(true))

      act(() => result.current.reset())
      expect(result.current.isResolving).toBe(false)
      await act(async () => resolveLookup([]))
      expect(result.current.isResolving).toBe(false)
    })

    it('rehydrates a fixed initialRunId after its scope changes', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const run = await handle.trigger({ input: 'test' })
      let resolveOldRead!: (
        value: Awaited<ReturnType<typeof handle.getRun>>,
      ) => void
      vi.spyOn(durably.storage, 'getRun').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRead = resolve
          }),
      )
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob(testJob, {
            initialRunId: run.id,
            scope: { labels: { documentId } },
          }),
        {
          wrapper: createWrapper(durably),
          initialProps: { documentId: 'one' },
        },
      )
      rerender({ documentId: 'two' })
      await waitFor(() => expect(result.current.status).toBe('pending'))
      await act(async () => resolveOldRead(null))
      expect(result.current.currentRunId).toBe(run.id)
      expect(result.current.status).toBe('pending')
    })

    it('restores a fixed initialRunId after following another run and changing scope', async () => {
      const durably = await createTestDurably({ autoStart: false })
      instances.push(durably)
      const handle = durably.register({ testJob }).jobs.testJob
      const fixed = await handle.trigger({ input: 'fixed' })
      const { result, rerender } = renderHook(
        ({ documentId }: { documentId: string }) =>
          useJob(testJob, {
            initialRunId: fixed.id,
            scope: { labels: { documentId } },
          }),
        {
          wrapper: createWrapper(durably),
          initialProps: { documentId: 'first' },
        },
      )
      await waitFor(() => expect(result.current.status).toBe('pending'))
      const followed = await handle.trigger(
        { input: 'followed' },
        { labels: { documentId: 'first' } },
      )
      await waitFor(() => expect(result.current.currentRunId).toBe(followed.id))
      act(() => {
        durably.emit({
          type: 'run:leased',
          runId: followed.id,
          jobName: testJob.name,
          input: { input: 'followed' },
          leaseOwner: 'worker-1',
          leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(),
          labels: { documentId: 'first' },
        })
        durably.emit({
          type: 'run:progress',
          runId: followed.id,
          jobName: testJob.name,
          progress: { current: 1, total: 2 },
          labels: { documentId: 'first' },
        })
        durably.emit({
          type: 'log:write',
          runId: followed.id,
          jobName: testJob.name,
          labels: { documentId: 'first' },
          stepName: null,
          level: 'info',
          message: 'old run log',
          data: null,
        })
      })
      expect(result.current.status).toBe('leased')
      expect(result.current.progress).toEqual({ current: 1, total: 2 })
      expect(result.current.logs.map((log) => log.message)).toEqual([
        'old run log',
      ])
      rerender({ documentId: 'second' })
      await waitFor(() => {
        expect(result.current.currentRunId).toBe(fixed.id)
        expect(result.current.status).toBe('pending')
        expect(result.current.progress).toBeNull()
        expect(result.current.logs).toEqual([])
      })
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
      getRun.mockResolvedValueOnce(terminal)

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
      expect(getRun).toHaveBeenCalledTimes(1)
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
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(3))
      rerender()
      await act(async () => Promise.resolve())
      expect(getRuns).toHaveBeenCalledTimes(3)
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
      await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(3))
      rerender({ reverse: true })
      await act(async () => Promise.resolve())
      expect(getRuns).toHaveBeenCalledTimes(3)
    })
  })
})
