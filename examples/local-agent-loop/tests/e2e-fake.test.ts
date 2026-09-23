/**
 * Fake-mode end-to-end: tests pass -> review needsChanges -> fix ->
 * re-verify -> re-review pass -> approval -> completed(approved).
 *
 * Runs a real Durably worker in-process against a temp SQLite file, so the
 * Policy -> Stage -> Event loop, strict verdicts, and approval binding are
 * exercised through durable steps (not mocks).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import { checkpointPaths } from '../src/engine/runner.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe('fake e2e fix loop', { timeout: 180000 }, () => {
  it('tests-pass -> needsChanges -> fix -> re-review pass -> approved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-'))
    process.env.FAKE_FAIL_FIRST = '0'
    // Round 1: one branch reports needsChanges (which branch wins the race
    // does not matter); round 2 defaults to pass/pass.
    process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
    delete process.env.FAKE_REVIEW_SLOW_MS

    const durably = createAgentDurably({ stateRoot: dir })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 3,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
        'run reaches human-approval wait',
      )
      const waits = await durably.getWaits(run.id)
      const wait = waits.find((w) => w.name.includes(':approve:'))
      assert.ok(wait, 'candidate approval wait exists')
      const candidateId = (wait.metadata as { candidateId?: string })
        .candidateId
      assert.ok(candidateId)

      // Idempotent redelivery with the same signal id resolves the same
      // wait instead of double-applying; a conflicting payload is rejected.
      await durably.signal(
        wait.id,
        { candidateId, decision: 'approved' },
        { signalId: 'e2e-approve-1' },
      )
      await durably.signal(
        wait.id,
        { candidateId, decision: 'approved' },
        { signalId: 'e2e-approve-1' },
      )
      await assert.rejects(
        durably.signal(
          wait.id,
          { candidateId, decision: 'rejected' },
          { signalId: 'e2e-conflict-1' },
        ),
        /cannot accept|Conflict/i,
      )

      await waitFor(
        async () => {
          const s = (await durably.getRun(run.id))?.status
          return s === 'completed' || s === 'failed'
        },
        60000,
        'run reaches terminal state',
      )
      const final = await durably.getRun(run.id)
      assert.equal(final?.status, 'completed')
      const output = final?.output as {
        approved: boolean
        conclusion: string
        iterations: number
        reviewRounds: number
        reviews: { lens: string; decision: string }[]
      }
      assert.equal(output.approved, true)
      assert.equal(output.conclusion, 'approved')
      // Prove the fix loop ran: two review rounds, finished on iteration 2.
      assert.equal(output.reviewRounds, 2)
      assert.equal(output.iterations, 2)
      assert.ok(
        output.reviews.every((r) => r.decision === 'pass'),
        'final round reviews both pass',
      )

      const attempts = await durably.getStepAttempts(run.id)
      const names = attempts.map((a) => a.stepName)
      assert.ok(names.some((name) => name.endsWith(':code:agent')))
      assert.ok(
        names.filter((name) => name.endsWith(':code:agent')).length >= 2,
        'repair ran after needsChanges',
      )
      assert.ok(names.some((name) => name.endsWith(':correctness')))
      assert.ok(names.some((name) => name.endsWith(':edge-cases')))
      assert.ok(
        names.some((n) => n.startsWith('decision:')),
        'policy decisions persisted to named steps',
      )
      const codeSessions = attempts
        .map(
          (attempt) =>
            attempt.metadata as {
              role?: string
              sessionId?: string
            } | null,
        )
        .filter(
          (measurement) =>
            measurement?.role === 'implement' || measurement?.role === 'repair',
        )
        .map((measurement) => measurement?.sessionId)
      assert.equal(codeSessions.length, 2)
      assert.equal(
        codeSessions[0],
        codeSessions[1],
        'repair explicitly resumes the implementation session',
      )
      // Every review call, in both rounds, started its own new session: the
      // two parallel reviewers never share one, and none continues the
      // implementation conversation.
      const reviewSessions = attempts
        .map(
          (attempt) =>
            attempt.metadata as { role?: string; sessionId?: string } | null,
        )
        .filter(
          (measurement) =>
            measurement?.role === 'review-a' ||
            measurement?.role === 'review-b',
        )
        .map((measurement) => measurement?.sessionId)
      assert.equal(reviewSessions.length, 4)
      assert.equal(new Set(reviewSessions).size, 4)
      assert.ok(reviewSessions.every((id) => typeof id === 'string'))
      assert.ok(!reviewSessions.includes(codeSessions[0] as string))
      // The run's data lives under the state root it was given.
      const outputDir =
        (final?.output as { workdir?: string } | undefined)?.workdir ?? ''
      assert.ok(outputDir.startsWith(join(dir, 'runs', run.id)), outputDir)
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('uses a new implementation session for each fresh-mode repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-fresh-'))
    process.env.FAKE_FAIL_FIRST = '0'
    process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 3,
        context: 'fresh',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
        'fresh run reaches approval',
      )
      const attempts = await durably.getStepAttempts(run.id)
      const sessions = attempts
        .map(
          (attempt) =>
            attempt.metadata as { role?: string; sessionId?: string } | null,
        )
        .filter(
          (measurement) =>
            measurement?.role === 'implement' || measurement?.role === 'repair',
        )
        .map((measurement) => measurement?.sessionId)
      assert.equal(sessions.length, 2)
      assert.notEqual(sessions[0], sessions[1])
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })
})

describe('fake runs that stop', { timeout: 180000 }, () => {
  it('shows verification failure, review cap and an uncertain call differently in status and report', async () => {
    // The CLI resolves the state root from HOME, so put the database there.
    const home = await mkdtemp(join(tmpdir(), 'e2e-stops-'))
    const dir = join(home, '.local', 'state', 'local-agent-loop')
    delete process.env.FAKE_FAIL_FIRST
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_REVIEW_SLOW_MS

    const durably = createAgentDurably({ stateRoot: dir })
    await durably.migrate()
    const ids: Record<string, string> = {}
    try {
      const subject = (maxIterations: number) =>
        durably.jobs.agentLoop.trigger({
          provider: 'fake',
          target: { kind: 'subject' as const },
          maxIterations,
          context: 'reuse',
        })
      // The first implementation leaves the bug in place and there is no
      // second iteration, so the pinned check fails for good.
      ids['verification'] = (await subject(1)).id
      // A worker died after sending the first implementation prompt: its
      // start checkpoint exists and its completion does not. Written before
      // any worker runs, so the run meets it on the first call.
      const uncertain = await subject(1)
      ids['uncertain'] = uncertain.id
      const checkpointsDir = join(
        dir,
        'runs',
        uncertain.id,
        'operation-checkpoints',
      )
      await mkdir(checkpointsDir, { recursive: true })
      const operationKey = `${uncertain.id}/stage:0:code/agent`
      await writeFile(
        checkpointPaths(checkpointsDir, operationKey).started,
        `${JSON.stringify({
          operationKey,
          invocationId: 'lost-invocation',
          status: 'started',
          invocationStartedAt: new Date().toISOString(),
        })}\n`,
      )
      await durably.init()
      const settled = (id: string) => async () => {
        const s = (await durably.getRun(id))?.status
        return s === 'completed' || s === 'failed'
      }
      await waitFor(settled(ids['verification']), 60000, 'verification run')
      await waitFor(settled(ids['uncertain']), 60000, 'uncertain run')
      // The check passes at once, but a reviewer asks for changes and there
      // is no repair left.
      process.env.FAKE_FAIL_FIRST = '0'
      process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
      ids['review'] = (await subject(1)).id
      await waitFor(settled(ids['review']), 60000, 'review-cap run')

      const expected = {
        verification: 'verification-failed',
        review: 'review-cap-reached',
        uncertain: 'uncertain-invocation',
      } as const
      const reasons = new Set<string>()
      const nexts = new Set<string>()
      for (const [name, kind] of Object.entries(expected)) {
        const id = ids[name] ?? ''
        const report = await buildReport(durably, id)
        assert.equal(report.failure?.kind, kind, `${name}: ${report.status}`)
        reasons.add(report.failure?.reason ?? '')
        nexts.add(JSON.stringify(report.failure?.next))
        assert.equal(report.failure?.retryable, kind !== 'uncertain-invocation')
        const json = JSON.parse(reportToJson(report)) as {
          failure: { kind: string }
        }
        assert.equal(json.failure.kind, kind)
        const md = reportToMarkdown(report)
        assert.ok(md.includes(`- kind: ${kind}`))
        // The existing sections stay.
        for (const heading of ['## Candidate', '## Delivery', '## Summary'])
          assert.ok(md.includes(heading), heading)
        if (kind === 'uncertain-invocation') {
          assert.ok(md.includes('NO — do not start a new run'))
          assert.ok(!md.includes('retrigger'))
        }
      }
      assert.equal(reasons.size, 3)
      assert.equal(nexts.size, 3)
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_REVIEW_SEQUENCE
    }

    const res = await runChild(
      join(packageRoot, 'node_modules', '.bin', 'tsx'),
      [join(packageRoot, 'src', 'cli.ts'), 'status'],
      { cwd: home, timeoutMs: 60000, env: { HOME: home } },
    )
    assert.equal(res.code, 0, res.stderr)
    const blocks = res.stdout.split('\n\n')
    const block = (id: string) => blocks.find((b) => b.startsWith(id)) ?? ''
    const verification = block(ids['verification'] ?? '')
    const review = block(ids['review'] ?? '')
    const uncertain = block(ids['uncertain'] ?? '')
    assert.match(verification, /verification-failed:/)
    assert.match(verification, /retry: +yes/)
    assert.match(review, /review-cap-reached:/)
    assert.match(review, /retry: +yes/)
    assert.match(uncertain, /uncertain-invocation:/)
    assert.match(uncertain, /retry: +NO/)
    assert.match(uncertain, /start checkpoint without completion/)
    // Nothing that would send the lost prompt again.
    assert.doesNotMatch(uncertain, /trigger|demo worker/)
    assert.match(verification, /demo retrigger --run /)
    // retrigger refuses a stop that is not safe to repeat, and starts a new
    // run from the stored input for one that is.
    const retrigger = (id: string) =>
      runChild(
        join(packageRoot, 'node_modules', '.bin', 'tsx'),
        [join(packageRoot, 'src', 'cli.ts'), 'retrigger', '--run', id],
        { cwd: home, timeoutMs: 60000, env: { HOME: home } },
      )
    const refused = await retrigger(ids['uncertain'] ?? '')
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr, /refusing to retrigger/)
    const again = await retrigger(ids['verification'] ?? '')
    assert.equal(again.code, 0, again.stderr)
    assert.match(again.stdout, /^new run \S+ with the input of /)
    // Pasting the same command again does not start a second run.
    const twice = await retrigger(ids['verification'] ?? '')
    assert.equal(twice.code, 0, twice.stderr)
    assert.match(
      twice.stdout,
      /^already retriggered as \S+; nothing new started/,
    )
    // A subject run has no worktree to remove.
    assert.doesNotMatch(res.stdout, /worktree remove/)
  })
})
