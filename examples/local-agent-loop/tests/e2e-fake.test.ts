/**
 * Fake-mode end-to-end: tests pass -> review needsChanges -> fix ->
 * re-verify -> re-review pass -> approval -> completed(approved).
 *
 * Runs a real Durably worker in-process against a temp SQLite file, so the
 * Policy -> Stage -> Event loop, strict verdicts, and approval binding are
 * exercised through durable steps (not mocks).
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createAgentDurably } from '../src/durably.js'

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
