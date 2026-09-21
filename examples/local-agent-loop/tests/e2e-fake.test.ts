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
    await new Promise((r) => setTimeout(r, 500))
  }
}

describe('fake e2e fix loop', { timeout: 180000 }, () => {
  it('tests-pass -> needsChanges -> fix -> re-review pass -> approved', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-'))
    process.env.DURABLY_DB = join(dir, 'e2e.db')
    process.env.FAKE_FAIL_FIRST = '0'
    // Round 1: one branch reports needsChanges (which branch wins the race
    // does not matter); round 2 defaults to pass/pass.
    process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
    delete process.env.FAKE_REVIEW_SLOW_MS

    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        maxIterations: 3,
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'waiting',
        120000,
        'run reaches human-approval wait',
      )
      const waits = await durably.getWaits(run.id)
      const wait = waits.find((w) => w.name === 'human-approval')
      assert.ok(wait, 'human-approval wait exists')

      // Idempotent redelivery with the same signal id resolves the same
      // wait instead of double-applying; a conflicting payload is rejected.
      await durably.signal(
        wait.id,
        { decision: 'approved' },
        { signalId: 'e2e-approve-1' },
      )
      await durably.signal(
        wait.id,
        { decision: 'approved' },
        { signalId: 'e2e-approve-1' },
      )
      await assert.rejects(
        durably.signal(
          wait.id,
          { decision: 'rejected' },
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
        testsPassed: boolean
        iterations: number
        reviewRounds: number
        reviews: { reviewer: string; decision: string }[]
      }
      assert.equal(output.approved, true)
      assert.equal(output.conclusion, 'approved')
      assert.equal(output.testsPassed, true)
      // Prove the fix loop ran: two review rounds, finished on iteration 2.
      assert.equal(output.reviewRounds, 2)
      assert.equal(output.iterations, 2)
      assert.ok(
        output.reviews.every((r) => r.decision === 'pass'),
        'final round reviews both pass',
      )

      const attempts = await durably.getStepAttempts(run.id)
      const names = attempts.map((a) => a.stepName)
      assert.ok(names.includes('implement:1'), 'implement:1 ran')
      assert.ok(
        names.includes('implement:2'),
        'implement:2 ran after needsChanges',
      )
      assert.ok(names.includes('review-a:1'), 'round-1 reviews ran')
      assert.ok(names.includes('review-b:2'), 'round-2 reviews ran')
      assert.ok(
        names.some((n) => n.startsWith('policy:')),
        'policy decisions persisted to named steps',
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })
})
