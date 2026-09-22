import assert from 'node:assert/strict'
import { appendFile, chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { createAgentDurably } from '../src/durably.js'
import { hashDir } from '../src/engine/tree.js'

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe('candidate-bound approval', { timeout: 180000 }, () => {
  it('returns the reviewed candidate even when the editable workdir changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'candidate-approval-'))
    process.env.DURABLY_DB = join(dir, 'run.db')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
      )
      const wait = (await durably.getWaits(run.id))[0]
      assert.ok(wait)
      const metadata = wait.metadata as {
        candidateId: string
        snapshotDir: string
        sourceHash: string
      }
      await appendFile(
        join(dirname(dirname(metadata.snapshotDir)), 'work', 'src', 'calc.js'),
        '\n// editable workdir changed after candidate creation\n',
      )
      const before = await hashDir(metadata.snapshotDir)
      assert.equal(before, metadata.sourceHash)
      await durably.signal(
        wait.id,
        { candidateId: metadata.candidateId, decision: 'approved' },
        { signalId: 'candidate-approval' },
      )
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        60000,
      )
      const output = (await durably.getRun(run.id))?.output as {
        approved: boolean
        candidate: { id: string; sourceHash: string }
      }
      assert.equal(output.approved, true)
      assert.equal(output.candidate.id, metadata.candidateId)
      assert.equal(output.candidate.sourceHash, metadata.sourceHash)
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('fails when the candidate itself changes during approval wait', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'candidate-tamper-'))
    process.env.DURABLY_DB = join(dir, 'run.db')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
      )
      const wait = (await durably.getWaits(run.id))[0]
      assert.ok(wait)
      const metadata = wait.metadata as {
        candidateId: string
        snapshotDir: string
      }
      const candidateFile = join(metadata.snapshotDir, 'src', 'calc.js')
      await chmod(candidateFile, 0o644)
      await appendFile(
        candidateFile,
        '\n// candidate tampered during approval\n',
      )
      await durably.signal(
        wait.id,
        { candidateId: metadata.candidateId, decision: 'approved' },
        { signalId: 'candidate-tamper' },
      )
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'failed',
        60000,
      )
      assert.match(
        (await durably.getRun(run.id))?.error ?? '',
        /candidate-mutated/,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })
})
