/**
 * useJobLogs Tests
 *
 * Test useJobLogs hook for subscribing to logs
 */

import { defineJob, type Durably } from '@coji/durably'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { DurablyProvider, useDurably, useJobLogs } from '../../src/spa'
import { createTestDurably } from '../helpers/create-test-durably'

// Browser useJobLogs only listens to log events, so logs written before the
// hook subscribes are never observed. Each run waits at its gate until the
// test has subscribed to it (see `subscribe`) instead of sleeping and hoping
// the subscription wins the race.
type Gate = { promise: Promise<void>; open: () => void }
const gates = new Map<string, Gate>()
let gatesForcedOpen = false

function gate(runId: string): Gate {
  let entry = gates.get(runId)
  if (!entry) {
    let open!: () => void
    const promise = new Promise<void>((resolve) => {
      open = resolve
    })
    entry = { promise, open }
    gates.set(runId, entry)
    if (gatesForcedOpen) open()
  }
  return entry
}

async function subscribe(
  result: { current: { runId: string | null; setRunId: (id: string) => void } },
  runId: string,
) {
  act(() => {
    result.current.setRunId(runId)
  })
  // renderHook publishes result.current from an effect declared after the
  // hook's subscription effect, so the new runId means the hook is listening.
  await waitFor(() => expect(result.current.runId).toBe(runId), {
    timeout: 5000,
  })
  gate(runId).open()
}

const loggingJob = defineJob({
  name: 'logging-job-logs',
  input: z.object({ count: z.number() }),
  run: async (context, payload) => {
    await gate(context.runId).promise
    for (let i = 0; i < payload.count; i++) {
      context.log.info(`Log ${i + 1}`)
      await context.run(`step${i}`, async () => `done${i}`)
    }
  },
})

describe('useJobLogs', () => {
  const instances: Durably[] = []

  afterEach(async () => {
    // Stopping waits for active runs, so let every gated run finish.
    gatesForcedOpen = true
    for (const entry of gates.values()) entry.open()
    for (const instance of instances) {
      try {
        await instance.stop()
      } catch {
        // Ignore errors from already stopped instances
      }
    }
    instances.length = 0
    gates.clear()
    gatesForcedOpen = false
    // sleep-ok(yield): settles leftover async work after stop(); every test
    // uses its own database, so nothing depends on how long this is.
    await new Promise((r) => setTimeout(r, 200))
  })

  const createWrapper = (durably: Durably) => {
    return ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )
  }

  it('collects logs for run', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 3 })
    await subscribe(result, run.id)

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJobLogs({ runId: null }), {
      wrapper: createWrapper(durably),
    })

    // With null runId, logs should be empty
    expect(result.current.logs).toEqual([])
  })

  it('respects maxLogs limit', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId, maxLogs: 5 })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 10 })
    await subscribe(result, run.id)

    await durably.waitForRun(run.id, { timeout: 5000 })

    // All 10 logs arrived, and only the latest 5 are kept
    await waitFor(
      () => {
        expect(result.current.logs).toHaveLength(5)
      },
      { timeout: 5000 },
    )
    expect(result.current.logs.map((log) => log.message)).toEqual([
      'Log 6',
      'Log 7',
      'Log 8',
      'Log 9',
      'Log 10',
    ])
  })

  it('clears logs on clearLogs call', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobLogs({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({
      _job: loggingJob,
    })
    const run = await d.jobs._job.trigger({ count: 3 })
    await subscribe(result, run.id)

    // Wait for job to complete and all its logs to be collected, so no log
    // can arrive after clearLogs
    await durably.waitForRun(run.id, { timeout: 5000 })
    await waitFor(
      () => {
        expect(result.current.logs).toHaveLength(3)
      },
      { timeout: 5000 },
    )

    // Clear logs after job is done
    result.current.clearLogs()

    // Wait for the state update to propagate
    await waitFor(() => {
      expect(result.current.logs.length).toBe(0)
    })
  })
})
