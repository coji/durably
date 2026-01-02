/**
 * useJobRun Tests
 *
 * Test useJobRun hook for subscribing to existing runs
 */

import { defineJob, type Durably } from '@coji/durably'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DurablyProvider, useDurably, useJobRun } from '../../src'
import { createTestDurably } from '../helpers/create-test-durably'

// Test job definitions - use slow jobs to ensure we can subscribe before completion
const testJob = defineJob({
  name: 'test-job-run',
  input: z.object({ input: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (context, payload) => {
    await context.run('process', async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    return { result: `processed: ${payload.input}` }
  },
})

const failingJob = defineJob({
  name: 'failing-job-run',
  input: z.object({ input: z.string() }),
  run: async (context) => {
    await context.run('fail', async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    throw new Error('Job failed')
  },
})

const progressJob = defineJob({
  name: 'progress-job-run',
  input: z.object({ input: z.string() }),
  output: z.object({ done: z.boolean() }),
  run: async (context) => {
    context.progress(1, 2, 'Step 1')
    await context.run('step1', async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    context.progress(2, 2, 'Step 2')
    return { done: true }
  },
})

describe('useJobRun', () => {
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

  it('subscribes to run by id', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    // Use a combined hook that triggers then subscribes
    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // Trigger job and set runId
    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })

    // Update runId to start subscription
    result.current.setRunId(run.id)

    // Should eventually see the run complete
    await waitFor(
      () => {
        expect(result.current.status).not.toBeNull()
      },
      { timeout: 3000 },
    )
  })

  it('handles null runId', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJobRun({ runId: null }), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // With null runId, status should remain null
    expect(result.current.status).toBeNull()
    expect(result.current.output).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('provides output when run completes', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun<{ result: string }>({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'hello' })
    result.current.setRunId(run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ result: 'processed: hello' })
      },
      { timeout: 3000 },
    )
  })

  it('provides error when run fails', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const d = durably.register({
      _job: failingJob,
    })
    const run = await d.jobs._job.trigger({ input: 'test' })
    result.current.setRunId(run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('failed')
        expect(result.current.error).toBe('Job failed')
      },
      { timeout: 3000 },
    )
  })

  it('tracks progress updates', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const d = durably.register({
      _job: progressJob,
    })
    const run = await d.jobs._job.trigger({ input: 'test' })
    result.current.setRunId(run.id)

    // Should eventually see progress or complete
    await waitFor(
      () => {
        expect(
          result.current.progress !== null ||
            result.current.status === 'completed',
        ).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it('provides boolean helpers', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    result.current.setRunId(run.id)

    await waitFor(
      () => {
        expect(result.current.isCompleted).toBe(true)
      },
      { timeout: 3000 },
    )

    expect(result.current.isRunning).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isFailed).toBe(false)
  })
})
