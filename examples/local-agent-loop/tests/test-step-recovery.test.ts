import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { runVerificationStep } from '../src/engine/verification.js'
import {
  runAcceptanceSuite,
  snapshotAcceptance,
} from '../src/targets/subject-acceptance.js'

const here = dirname(fileURLToPath(import.meta.url))

function attempt() {
  const snapshots: AttemptMeasurement[] = []
  return {
    id: randomUUID(),
    snapshots,
    log: { info: () => {} },
    setMetadata: async (value: unknown) => {
      snapshots.push(value as AttemptMeasurement)
    },
  }
}

describe('verification invocation recovery', () => {
  it('re-grades a start-only acceptance invocation instead of poisoning the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'verify-checkpoint-'))
    const workdir = join(root, 'work')
    const acceptanceDir = join(root, 'acceptance')
    await cp(join(here, '..', 'subject'), workdir, { recursive: true })
    const acceptance = await snapshotAcceptance(
      join(here, '..', 'subject', 'test'),
      acceptanceDir,
    )
    const spec = {
      provider: 'fake' as const,
      operationKey: 'run/stage:1:verify/acceptance',
      checkpointsDir: join(root, 'checkpoints'),
      stage: 'verify',
      iteration: 1,
      grade: (signal: AbortSignal) =>
        runAcceptanceSuite(
          {
            workdir,
            acceptanceDir,
            scratchDir: join(root, 'scratch'),
            timeoutMs: 10000,
            signal,
          },
          acceptance.hash,
        ),
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runVerificationStep(attempt() as never, spec, controller.signal),
      /aborted before spawn/,
    )
    // Local grading only reads the sealed candidate and writes to a scratch
    // directory, so re-running it is free and repeatable. The uncertainty
    // contract exists for an LLM call that may already have been billed, and
    // applying it here would fail the run for good on the documented
    // `kill -9 the worker` resume demo.
    const graded = await runVerificationStep(
      attempt() as never,
      spec,
      new AbortController().signal,
    )
    assert.equal(typeof graded.passed, 'boolean')
    // That completion is checkpointed, so a further replay reads it back
    // instead of grading a third time.
    const replayAttempt = attempt()
    const replayed = await runVerificationStep(
      replayAttempt as never,
      spec,
      new AbortController().signal,
    )
    assert.deepEqual(replayed, graded)
    assert.equal(replayAttempt.snapshots.at(-1)?.recovered, true)
  })
})
