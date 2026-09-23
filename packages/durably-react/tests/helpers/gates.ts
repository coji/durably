import { act, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

/**
 * A promise a job awaits until the test opens it, so the test decides when
 * the job moves on instead of sleeping and hoping it has not moved on yet.
 */
export type Gate = { promise: Promise<void>; open: () => void }

export function createGate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * Gates keyed by run ID. Either side may create a run's gate first: the job
 * awaits `get(runId).promise`, the test calls `get(runId).open()`.
 *
 * `durably.stop()` waits for active runs, so call `openAll()` before stopping
 * instances in `afterEach`, and `reset()` after.
 */
export function createGates() {
  const gates = new Map<string, Gate>()
  let forcedOpen = false

  return {
    get(runId: string): Gate {
      let entry = gates.get(runId)
      if (!entry) {
        entry = createGate()
        gates.set(runId, entry)
        if (forcedOpen) entry.open()
      }
      return entry
    },
    /** Opens every gate, including ones created from now until `reset()`. */
    openAll() {
      forcedOpen = true
      for (const entry of gates.values()) entry.open()
    },
    reset() {
      gates.clear()
      forcedOpen = false
    },
  }
}

export type Gates = ReturnType<typeof createGates>

/**
 * Points an event-only hook at `runId`, waits until it is listening, and only
 * then lets the run proceed, so none of the run's events are missed.
 */
export async function subscribeThenOpen(
  result: { current: { runId: string | null; setRunId: (id: string) => void } },
  runId: string,
  gates: Gates,
) {
  act(() => {
    result.current.setRunId(runId)
  })
  // renderHook publishes result.current from an effect declared after the
  // hook's subscription effect, so the new runId means the hook is listening.
  await waitFor(() => expect(result.current.runId).toBe(runId), {
    timeout: 5000,
  })
  gates.get(runId).open()
}
