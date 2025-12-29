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
import { createBrowserDialect } from '../helpers/browser-dialect'

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
  // Track all instances created during tests for cleanup
  const instances: Durably[] = []

  // Create a shared dialect for tests that need to share the same Durably instance
  let sharedDialect: ReturnType<typeof createBrowserDialect> | null = null

  const getSharedDialect = () => {
    if (!sharedDialect) {
      sharedDialect = createBrowserDialect()
    }
    return sharedDialect
  }

  // Helper to create wrapper with shared dialect
  const createSharedWrapper =
    () =>
    ({ children }: { children: ReactNode }) => (
      <DurablyProvider
        dialectFactory={getSharedDialect}
        options={{ pollingInterval: 50 }}
        onReady={(durably) => {
          if (!instances.includes(durably)) {
            instances.push(durably)
          }
        }}
      >
        {children}
      </DurablyProvider>
    )

  // Helper to create wrapper with new dialect
  const createWrapper =
    () =>
    ({ children }: { children: ReactNode }) => (
      <DurablyProvider
        dialectFactory={() => createBrowserDialect()}
        options={{ pollingInterval: 50 }}
        onReady={(durably) => instances.push(durably)}
      >
        {children}
      </DurablyProvider>
    )

  afterEach(async () => {
    for (const instance of instances) {
      try {
        await instance.stop()
      } catch {
        // Ignore errors from already stopped instances
      }
    }
    instances.length = 0
    sharedDialect = null
    await new Promise((r) => setTimeout(r, 200))
  })

  it('collects logs for run', async () => {
    function useTriggerAndSubscribe() {
      const { durably, isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        durably,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createSharedWrapper(),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { _job: handle } = result.current.durably!.register({ _job: loggingJob })
    const run = await handle.trigger({ count: 3 })
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
    const { result } = renderHook(() => useJobLogs({ runId: null }), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    // With null runId, logs should be empty
    expect(result.current.logs).toEqual([])
  })

  it('respects maxLogs limit', async () => {
    function useTriggerAndSubscribe() {
      const { durably, isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId, maxLogs: 5 })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        durably,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createSharedWrapper(),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { _job: handle } = result.current.durably!.register({ _job: loggingJob })
    const run = await handle.trigger({ count: 10 })
    result.current.setRunId(run.id)

    // Wait for job to complete
    await new Promise((r) => setTimeout(r, 500))

    // Should have at most 5 logs
    expect(result.current.logs.length).toBeLessThanOrEqual(5)
  })

  it('clears logs on clearLogs call', async () => {
    function useTriggerAndSubscribe() {
      const { durably, isReady: durablyReady } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

      return {
        ...subscription,
        isReady: durablyReady && subscription.isReady,
        durably,
        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createSharedWrapper(),
    })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { _job: handle } = result.current.durably!.register({ _job: loggingJob })
    const run = await handle.trigger({ count: 3 })
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
