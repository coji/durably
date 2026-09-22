import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { snapshotAcceptance } from '../src/acceptance.js'
import type { AttemptMeasurement } from '../src/providers/types.js'
import { runAgentTestStep } from '../src/test-step.js'

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
  it('does not resend a start-only acceptance invocation', async () => {
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
      workdir,
      acceptanceHash: acceptance.hash,
      acceptanceDir,
      scratchDir: join(root, 'scratch'),
      operationKey: 'run/stage:1:verify/acceptance',
      checkpointsDir: join(root, 'checkpoints'),
      timeoutMs: 10000,
      stage: 'verify',
      iteration: 1,
    }
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runAgentTestStep(attempt() as never, spec, controller.signal),
      /aborted before spawn/,
    )
    await assert.rejects(
      runAgentTestStep(attempt() as never, spec, new AbortController().signal),
      /uncertain external invocation/,
    )
  })
})
