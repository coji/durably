/**
 * useRuns Tests
 *
 * Test useRuns hook for browser-complete mode
 */

import { defineJob, type Durably } from '@coji/durably'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { DurablyProvider, useRuns } from '../../src/spa'
import { createTestDurably } from '../helpers/create-test-durably'

// Test job definition
const testJob = defineJob({
  name: 'test-job-runs',
  input: z.object({ value: z.number() }),
  run: async (context, payload) => {
    await context.run('work', async () => {
      // sleep-ok(work): tests wait for the runs list itself, not for this
      // run to be at any particular point.
      await new Promise((r) => setTimeout(r, 50))
      return payload.value * 2
    })
  },
})

describe('useRuns', () => {
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

  const createWrapper = (durably: Durably) => {
    return ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )
  }

  it('returns empty runs initially', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns(), {
      wrapper: createWrapper(durably),
    })

    expect(result.current.runs).toEqual([])
    expect(result.current.page).toBe(0)
    expect(result.current.hasMore).toBe(false)
  })

  it('lists runs after job execution', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns(), {
      wrapper: createWrapper(durably),
    })

    // Trigger a job using the durably instance directly
    const d = durably.register({ testJobHandle: testJob })
    await d.jobs.testJobHandle.trigger({ value: 10 })

    // Wait for runs to update
    await waitFor(() => {
      expect(result.current.runs.length).toBeGreaterThan(0)
    })

    expect(result.current.runs[0].jobName).toBe('test-job-runs')
  })

  it('ignores an older refresh that resolves after newer step progress', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)
    const d = durably.register({ testJobHandle: testJob })
    await d.jobs.testJobHandle.trigger({ value: 10 })
    const oldRuns = await d.getRuns()
    const newRuns = oldRuns.map((run) => ({
      ...run,
      currentStepIndex: 2,
      completedStepCount: 1,
    }))
    let releaseOld!: (runs: typeof oldRuns) => void
    const delayedOld = new Promise<typeof oldRuns>((resolve) => {
      releaseOld = resolve
    })
    const getRuns = vi
      .spyOn(durably, 'getRuns')
      .mockResolvedValueOnce(oldRuns)
      .mockReturnValueOnce(delayedOld)
      .mockResolvedValueOnce(newRuns)

    const { result } = renderHook(() => useRuns({ realtime: false }), {
      wrapper: createWrapper(durably),
    })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))

    let oldRefresh!: Promise<void>
    act(() => {
      oldRefresh = result.current.refresh()
    })
    await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(2))

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.runs[0].currentStepIndex).toBe(2)

    await act(async () => {
      releaseOld(oldRuns)
      await oldRefresh
    })
    expect(result.current.runs[0].currentStepIndex).toBe(2)
    expect(result.current.runs[0].completedStepCount).toBe(1)
  })

  it('applies an older successful refresh when a newer request fails', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)
    const d = durably.register({ testJobHandle: testJob })
    await d.jobs.testJobHandle.trigger({ value: 10 })
    const initialRuns = await d.getRuns()
    const updatedRuns = initialRuns.map((run) => ({
      ...run,
      currentStepIndex: 2,
      completedStepCount: 1,
    }))
    let releaseOlder!: (runs: typeof initialRuns) => void
    const olderResponse = new Promise<typeof initialRuns>((resolve) => {
      releaseOlder = resolve
    })
    const getRuns = vi
      .spyOn(durably, 'getRuns')
      .mockResolvedValueOnce(initialRuns)
      .mockReturnValueOnce(olderResponse)
      .mockRejectedValueOnce(new Error('temporary read failure'))

    const { result } = renderHook(() => useRuns({ realtime: false }), {
      wrapper: createWrapper(durably),
    })
    await waitFor(() => expect(result.current.runs).toHaveLength(1))

    let olderRefresh!: Promise<void>
    act(() => {
      olderRefresh = result.current.refresh()
    })
    await waitFor(() => expect(getRuns).toHaveBeenCalledTimes(2))
    await act(async () => {
      await expect(result.current.refresh()).rejects.toThrow(
        'temporary read failure',
      )
    })

    await act(async () => {
      releaseOlder(updatedRuns)
      await olderRefresh
    })
    expect(result.current.runs[0].currentStepIndex).toBe(2)
    expect(result.current.runs[0].completedStepCount).toBe(1)
  })

  it('filters by jobName', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const otherJob = defineJob({
      name: 'other-job',
      input: z.object({ x: z.string() }),
      run: async () => {},
    })

    const { result } = renderHook(() => useRuns({ jobName: 'test-job-runs' }), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({
      testJobHandle: testJob,
      otherJobHandle: otherJob,
    })

    await d.jobs.testJobHandle.trigger({ value: 1 })
    await d.jobs.otherJobHandle.trigger({ x: 'test' })

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })

    expect(result.current.runs[0].jobName).toBe('test-job-runs')
  })

  it('filters by status', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns({ status: 'completed' }), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    // Trigger and wait for completion
    const run = await d.jobs.testJobHandle.trigger({ value: 5 })

    // Wait for run to complete
    await waitFor(
      async () => {
        const runData = await d.jobs.testJobHandle.getRun(run.id)
        expect(runData?.status).toBe('completed')
      },
      { timeout: 5000 },
    )

    // Refresh to get completed runs
    await result.current.refresh()

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
      expect(result.current.runs[0].status).toBe('completed')
    })
  })

  it('filters by multiple statuses', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(
      () => useRuns({ status: ['pending', 'leased'] }),
      {
        wrapper: createWrapper(durably),
      },
    )

    const d = durably.register({ testJobHandle: testJob })

    await d.jobs.testJobHandle.trigger({ value: 1 })
    await d.jobs.testJobHandle.trigger({ value: 2 })

    await waitFor(() => {
      expect(result.current.runs.length).toBe(2)
    })

    for (const run of result.current.runs) {
      expect(['pending', 'leased']).toContain(run.status)
    }
  })

  it('supports pagination', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns({ pageSize: 2 }), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    // Create 3 runs
    await d.jobs.testJobHandle.trigger({ value: 1 })
    await d.jobs.testJobHandle.trigger({ value: 2 })
    await d.jobs.testJobHandle.trigger({ value: 3 })

    await waitFor(() => {
      expect(result.current.runs.length).toBe(2)
      expect(result.current.hasMore).toBe(true)
    })

    // Go to next page
    result.current.nextPage()

    await waitFor(() => {
      expect(result.current.page).toBe(1)
      expect(result.current.runs.length).toBe(1)
      expect(result.current.hasMore).toBe(false)
    })

    // Go back
    result.current.prevPage()

    await waitFor(() => {
      expect(result.current.page).toBe(0)
    })
  })

  it('goToPage navigates directly', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns({ pageSize: 1 }), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    // Create 3 runs
    await d.jobs.testJobHandle.trigger({ value: 1 })
    await d.jobs.testJobHandle.trigger({ value: 2 })
    await d.jobs.testJobHandle.trigger({ value: 3 })

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })

    result.current.goToPage(2)

    await waitFor(() => {
      expect(result.current.page).toBe(2)
    })
  })

  it('refresh reloads data', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    // Initially empty
    expect(result.current.runs).toEqual([])

    await d.jobs.testJobHandle.trigger({ value: 42 })

    // Manually refresh
    await result.current.refresh()

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })
  })

  it('updates in real-time by default', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    expect(result.current.runs.length).toBe(0)

    // Trigger job - should update automatically via events
    await d.jobs.testJobHandle.trigger({ value: 99 })

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })
  })

  it('disables real-time updates when realtime=false', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns({ realtime: false }), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ testJobHandle: testJob })

    await d.jobs.testJobHandle.trigger({ value: 77 })

    // Wait a bit - should NOT update automatically
    // sleep-ok(negative): gives an unwanted realtime refresh a chance to land;
    // a slow machine can only hide one, not fail the test.
    await new Promise((r) => setTimeout(r, 100))
    expect(result.current.runs.length).toBe(0)

    // Manual refresh should work
    await result.current.refresh()

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })
  })
})
