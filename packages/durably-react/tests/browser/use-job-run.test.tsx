/**
 * useJobRun Tests
 *
 * Test useJobRun hook for subscribing to existing runs
 */

import { defineJob, type Durably } from '@coji/durably'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { DurablyProvider, useDurably, useJobRun } from '../../src/spa'
import { createTestDurably } from '../helpers/create-test-durably'

// Browser useJobRun only listens to events, so a run that finishes before the
// hook subscribes is never observed. Each run waits at its gate until the test
// has subscribed to it (see `subscribe`) instead of sleeping and hoping the
// subscription wins the race.
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

const testJob = defineJob({
  name: 'test-job-run',
  input: z.object({ input: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (context, payload) => {
    await gate(context.runId).promise
    await context.run('process', async () => {})
    return { result: `processed: ${payload.input}` }
  },
})

const failingJob = defineJob({
  name: 'failing-job-run',
  input: z.object({ input: z.string() }),
  run: async (context) => {
    await gate(context.runId).promise
    await context.run('fail', async () => {})
    throw new Error('Job failed')
  },
})

const progressJob = defineJob({
  name: 'progress-job-run',
  input: z.object({ input: z.string() }),
  output: z.object({ done: z.boolean() }),
  run: async (context) => {
    await gate(context.runId).promise
    context.progress(1, 2, 'Step 1')
    await context.run('step1', async () => {})
    context.progress(2, 2, 'Step 2')
    return { done: true }
  },
})

describe('useJobRun', () => {
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

  it('subscribes to run by id', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    // Use a combined hook that triggers then subscribes
    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    // Trigger job and set runId
    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })

    // Update runId to start subscription
    await subscribe(result, run.id)

    // Should eventually see the run complete
    await waitFor(
      () => {
        expect(result.current.status).not.toBeNull()
      },
      { timeout: 3000 },
    )
  })

  it('handles null runId', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    const { result } = renderHook(() => useJobRun({ runId: null }), {
      wrapper: createWrapper(durably),
    })

    // With null runId, status should remain null
    expect(result.current.status).toBeNull()
    expect(result.current.output).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('provides output when run completes', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun<{ result: string }>({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'hello' })
    await subscribe(result, run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ result: 'processed: hello' })
      },
      { timeout: 3000 },
    )
  })

  it('provides error when run fails', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

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
      _job: failingJob,
    })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('failed')
        expect(result.current.error).toBe('Job failed')
      },
      { timeout: 3000 },
    )
  })

  it('updates status when run is cancelled', async () => {
    const durably = await createTestDurably({
      pollingIntervalMs: 50,
      autoStart: false,
    })
    instances.push(durably)

    // Worker is not started, so we can cancel before the job runs
    const noAutoStartWrapper = ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: noAutoStartWrapper,
    })

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    // Cancel the pending run (worker is not running)
    await durably.cancel(run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('cancelled')
        expect(result.current.isCancelled).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it('resets status when run is retried', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ _job: failingJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    // Wait for the run to fail
    await waitFor(
      () => {
        expect(result.current.status).toBe('failed')
        expect(result.current.error).toBe('Job failed')
      },
      { timeout: 3000 },
    )

    // Stop worker so retrigger doesn't immediately re-run
    await durably.stop()

    const nextRun = await durably.retrigger(run.id)
    await subscribe(result, nextRun.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('pending')
        expect(result.current.error).toBeNull()
        expect(result.current.isPending).toBe(true)
      },
      { timeout: 3000 },
    )
  })

  it('tracks retrigger from failed through completion', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    // Job that fails first time, succeeds on retrigger
    let attemptCount = 0
    const retriggerableJob = defineJob({
      name: 'retriggerable-job',
      input: z.object({ input: z.string() }),
      output: z.object({ result: z.string() }),
      run: async (context, payload) => {
        attemptCount++
        await gate(context.runId).promise
        await context.run('process', async () => {})
        if (attemptCount === 1) {
          throw new Error('First attempt failed')
        }
        return { result: `success: ${payload.input}` }
      },
    })

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun<{ result: string }>({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ _job: retriggerableJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    // Wait for the run to fail
    await waitFor(
      () => {
        expect(result.current.status).toBe('failed')
      },
      { timeout: 3000 },
    )

    const nextRun = await durably.retrigger(run.id)
    await subscribe(result, nextRun.id)

    // Should track through to completion
    await waitFor(
      () => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ result: 'success: test' })
      },
      { timeout: 3000 },
    )
  })

  it('tracks retrigger from cancelled through completion', async () => {
    const durably = await createTestDurably({
      pollingIntervalMs: 50,
      autoStart: false,
    })
    instances.push(durably)

    // Worker is not started, so we can control when the worker runs
    const noAutoStartWrapper = ({ children }: { children: ReactNode }) => (
      <DurablyProvider durably={durably}>{children}</DurablyProvider>
    )

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun<{ result: string }>({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: noAutoStartWrapper,
    })

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    // Cancel the pending run
    await durably.cancel(run.id)

    await waitFor(
      () => {
        expect(result.current.status).toBe('cancelled')
        expect(result.current.isCancelled).toBe(true)
      },
      { timeout: 3000 },
    )

    const nextRun = await durably.retrigger(run.id)
    await subscribe(result, nextRun.id)

    // Should see pending
    await waitFor(
      () => {
        expect(result.current.status).toBe('pending')
      },
      { timeout: 3000 },
    )

    // Start the worker to process the retriggered run
    durably.start()

    // Should track through to completion
    await waitFor(
      () => {
        expect(result.current.status).toBe('completed')
        expect(result.current.output).toEqual({ result: 'processed: test' })
      },
      { timeout: 3000 },
    )
  })

  it('tracks progress updates', async () => {
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

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
      _job: progressJob,
    })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

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
    const durably = await createTestDurably({ pollingIntervalMs: 50 })
    instances.push(durably)

    function useTriggerAndSubscribe() {
      const { durably: _ } = useDurably()
      const [runId, setRunId] = useState<string | null>(null)
      const subscription = useJobRun({ runId })

      return {
        ...subscription,

        runId,
        setRunId,
      }
    }

    const { result } = renderHook(() => useTriggerAndSubscribe(), {
      wrapper: createWrapper(durably),
    })

    const d = durably.register({ _job: testJob })
    const run = await d.jobs._job.trigger({ input: 'test' })
    await subscribe(result, run.id)

    await waitFor(
      () => {
        expect(result.current.isCompleted).toBe(true)
      },
      { timeout: 3000 },
    )

    expect(result.current.isLeased).toBe(false)
    expect(result.current.isPending).toBe(false)
    expect(result.current.isFailed).toBe(false)
    expect(result.current.isTerminal).toBe(true)
    expect(result.current.isActive).toBe(false)
  })
})
