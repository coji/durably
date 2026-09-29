import assert from 'node:assert/strict'
import { appendFile, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'

import { signalApproval, signalSpecDecision } from '../src/approval.js'
import { createAgentDurably } from '../src/durably.js'
import { runChild } from '../src/engine/child.js'
import { diagnose, needsHuman } from '../src/engine/status.js'
import { hashDir } from '../src/engine/tree.js'

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now()
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out')
    // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

describe('candidate-bound approval', { timeout: 180000 }, () => {
  it('returns the reviewed candidate even when the editable workdir changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'candidate-approval-'))
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: dir })
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
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: dir })
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

const FAKE = {
  provider: 'fake' as const,
  requestedModel: null,
  requestedEffort: null,
}

async function git(cwd: string, args: string[]): Promise<void> {
  const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
}

/** A repository run whose one spec reviewer blocks every round. */
async function blockedSpecRun(root: string) {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'ok.mjs'), 'process.exit(0)\n')
  await git(root, ['init', '--initial-branch=main', 'repo'])
  await git(repo, ['config', 'user.email', 'test@localhost'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'seed'])
  return {
    provider: 'fake' as const,
    target: {
      kind: 'repo' as const,
      repoPath: repo,
      baseRef: 'HEAD',
      task: 'Write the spec.',
      spec: null,
      dispositions: null,
      inputFiles: { task: null, spec: null, dispositions: null },
      issue: null,
      checkCommand: ['node', 'ok.mjs'],
      setupCommand: null,
      publish: false,
    },
    maxIterations: 1,
    context: 'reuse' as const,
    spec: {
      author: FAKE,
      fix: null,
      reviewers: [{ name: 'tech', profile: FAKE, invocation: null }],
      maxRounds: 1,
      template: null,
      reviewTemplate: null,
      templateFiles: { template: null, reviewTemplate: null },
    },
    fakeScenario: {
      specReviews: { tech: ['blocker' as const, 'blocker' as const] },
    },
  }
}

describe('spec-bound decisions', { timeout: 180000 }, () => {
  it('binds approve, revise and reject to the waiting run and spec version, and a reject starts no implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec-decision-'))
    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger(
        await blockedSpecRun(root),
      )
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
      )
      const [wait] = await durably.getWaits(run.id)
      assert.ok(wait)
      const metadata = wait.metadata as {
        kind: string
        runId: string
        specSha256: string
      }
      assert.equal(metadata.kind, 'spec-blocked')
      assert.equal(metadata.runId, run.id)
      // Told apart from a candidate approval, with the three decisions.
      const waiting = await durably.getRun(run.id)
      assert.ok(waiting)
      const d = await diagnose(durably, waiting, Date.now())
      assert.equal(d.kind, 'spec-approval')
      assert.ok(needsHuman(d.kind))
      assert.ok(
        d.next.some((n) =>
          n.includes(`approve --run ${run.id} --wait ${wait.id}`),
        ),
      )
      assert.ok(
        d.next.some((n) =>
          n.includes(`spec-revise --run ${run.id} --notes-file`),
        ),
      )
      assert.ok(
        d.next.some((n) =>
          n.includes(`reject --run ${run.id} --wait ${wait.id}`),
        ),
      )
      // Bound to this run: another run's id is refused, and so is a revise
      // without notes; neither signals anything.
      await assert.rejects(
        signalSpecDecision(durably, 'another-run', wait.id, 'approved', null),
        /not a spec-blocked wait/,
      )
      await assert.rejects(
        signalSpecDecision(durably, run.id, wait.id, 'revise', '  '),
        /needs notes/,
      )
      assert.equal((await durably.getWait(wait.id))?.status, 'pending')
      // A reject through the shared approve/reject path carries the run and
      // the spec version the wait names.
      await signalApproval(durably, run.id, wait.id, 'rejected')
      assert.deepEqual((await durably.getWait(wait.id))?.payload, {
        kind: 'spec',
        runId: run.id,
        specSha256: metadata.specSha256,
        decision: 'rejected',
        notes: null,
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        60000,
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        approved: boolean
        candidate: unknown
        iterations: number
      }
      assert.equal(output.conclusion, 'rejected')
      assert.equal(output.approved, false)
      assert.equal(output.candidate, null)
      assert.equal(output.iterations, 0)
      const steps = (await durably.getStepAttempts(run.id)).map(
        (a) => a.stepName,
      )
      assert.ok(!steps.some((n) => n.startsWith('stage:')))
      assert.ok(!steps.includes('spec:final'))
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('stops the run when a decision names another spec version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec-decision-stale-'))
    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger(
        await blockedSpecRun(root),
      )
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
      )
      const [wait] = await durably.getWaits(run.id)
      assert.ok(wait)
      await durably.signal(
        wait.id,
        {
          kind: 'spec',
          runId: run.id,
          specSha256: 'not-the-reviewed-spec',
          decision: 'approved',
          notes: null,
        },
        { signalId: 'stale-spec' },
      )
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'failed',
        60000,
      )
      assert.match(
        (await durably.getRun(run.id))?.error ?? '',
        /spec decision mismatch/,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })
})
