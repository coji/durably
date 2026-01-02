/**
 * useJobLogs Tests
 *
 * Test useJobLogs hook for subscribing to logs
 */

import { defineJob, type Durably } from '@coji/durably'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DurablyProvider, useDurably, useJobLogs } from '../../src'
import { createTestDurably } from '../helpers/create-test-durably'

// Test job that generates logs with delay to ensure we can subscribe
const loggingJob = defineJob({
  name: 'logging-job-logs',
  input: z.object({ count: z.number() }),
  run: async (context, payload) => {
    for (let i = 0; i < payload.count; i++) {
      context.log.info(`Log ${i + 1}`)
      await context.run(`step${i}`, async () => {
        await new Promise((r) => setTimeout(r, 30))
        return `done${i}`
      })
    }
  },
})

describe('useJobLogs', () => {
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

  it('collects logs for run', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

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
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 3 })
    result.current.setRunId(run.id)

    await waitFor(
      () => {
        expect(result.current.logs.length).toBeGreaterThan(0)
      },
      { timeout: 3000 },
    )

    // Check log structure
    const log = result.current.logs[0]
    expect(log.message).toBeDefined()
    expect(log.level).toBe('info')
    expect(log.runId).toBe(run.id)
  })

  it('handles null runId', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJobLogs({ runId: null }), {
      wrapper: createWrapper(durably),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // With null runId, logs should be empty
    expect(result.current.logs).toEqual([])
  })

  it('respects maxLogs limit', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId, maxLogs: 5 })

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
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 10 })
    result.current.setRunId(run.id)

    // Wait for job to complete
    await new Promise((r) => setTimeout(r, 500))

    // Should have at most 5 logs
    expect(result.current.logs.length).toBeLessThanOrEqual(5)
  })

  it('clears logs on clearLogs call', async () => {
    const durably = await createTestDurably({ pollingInterval: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

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
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 3 })
    result.current.setRunId(run.id)

    // Wait for job to complete and logs to be collected
    await new Promise((r) => setTimeout(r, 500))

    await waitFor(
      () => {
        expect(result.current.logs.length).toBeGreaterThan(0)
      },
      { timeout: 3000 },
    )

    // Clear logs after job is done
    result.current.clearLogs()

    // Wait for the state update to propagate
    await waitFor(() => {
      expect(result.current.logs.length).toBe(0)
    })
  })
})
