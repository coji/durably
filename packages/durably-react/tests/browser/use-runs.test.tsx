/**
 * useRuns Tests
 *
 * Test useRuns hook for browser-complete mode
 */

import { defineJob, type Durably } from '@coji/durably'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DurablyProvider, useRuns } from '../../src'
import { createTestDurably } from '../helpers/create-test-durably'

// Test job definition
const testJob = defineJob({
  name: 'test-job-runs',
  input: z.object({ value: z.number() }),
  run: async (context, payload) => {
    await context.run('work', async () => {
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
    await new Promise((r) => setTimeout(r, 200))
  })

  const createWrapper = (durably: Durably) => {
    return ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )
  }

  it('returns empty runs initially', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns(), {
      wrapper: createWrapper(durably),
    })

    expect(result.current.runs).toEqual([])
    expect(result.current.page).toBe(0)
    expect(result.current.hasMore).toBe(false)
  })

  it('lists runs after job execution', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
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

  it('filters by jobName', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
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
    const durably = await createTestDurably({ pollingInterval: 50 })
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

  it('supports pagination', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
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
    const durably = await createTestDurably({ pollingInterval: 50 })
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
    const durably = await createTestDurably({ pollingInterval: 50 })
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
    const durably = await createTestDurably({ pollingInterval: 50 })
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
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useRuns({ realtime: false }), {
      wrapper: createWrapper(durably),
    })


    const d = durably.register({ testJobHandle: testJob })

    await d.jobs.testJobHandle.trigger({ value: 77 })

    // Wait a bit - should NOT update automatically
    await new Promise((r) => setTimeout(r, 100))
    expect(result.current.runs.length).toBe(0)

    // Manual refresh should work
    await result.current.refresh()

    await waitFor(() => {
      expect(result.current.runs.length).toBe(1)
    })
  })
})
