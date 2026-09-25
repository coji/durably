/**
 * Fake-mode end-to-end: tests pass -> review needsChanges -> fix ->
 * re-verify -> re-review pass -> approval -> completed(approved).
 *
 * Runs a real Durably worker in-process against a temp SQLite file, so the
 * Policy -> Stage -> Event loop, strict verdicts, and approval binding are
 * exercised through durable steps (not mocks).
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { compareReports, comparisonToMarkdown } from '../src/engine/compare.js'
import {
  reportToJson,
  reportToMarkdown,
  triageCalibration,
} from '../src/engine/report.js'
import { checkpointPaths } from '../src/engine/runner.js'
import { codePrompt } from '../src/factory/prompts.js'

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
      // The report keeps every round in order, each with both verdicts and
      // notes and the candidate it reviewed; `reviews` stays the last one.
      const report = await buildReport(durably, run.id)
      assert.equal(report.reviewRounds.length, 2)
      const [round1, round2] = report.reviewRounds
      assert.deepEqual(
        report.reviewRounds.map((r) => r.round),
        [1, 2],
      )
      for (const round of report.reviewRounds) {
        assert.deepEqual(
          round.reviews.map((r) => r.lens),
          ['correctness', 'edge-cases'],
        )
        assert.ok(round.reviews.every((r) => r.notes.length > 0))
      }
      assert.ok(round1?.reviews.some((r) => r.decision === 'needsChanges'))
      assert.deepEqual(round2?.reviews, report.reviews)
      assert.equal(round1?.candidate?.id, report.candidates[0]?.id)
      assert.equal(round2?.candidate?.id, report.candidates[1]?.id)
      assert.equal(round2?.candidate?.id, report.candidate?.id)
      const md = reportToMarkdown(report)
      const roundsAt = md.indexOf('## Review rounds')
      assert.ok(md.indexOf('- round 1: ', roundsAt) > roundsAt)
      assert.ok(md.indexOf('- round 2: ', roundsAt) > md.indexOf('- round 1: '))

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
        if (kind === 'verification-failed') {
          // The failing check's full output is on disk, and the stop reason
          // names it with its exit code.
          const details = report.failure?.details ?? []
          assert.ok(details.includes('check exit code: 1'), details.join('\n'))
          const path = details
            .find((d) => d.startsWith('check stdout log: '))
            ?.slice('check stdout log: '.length)
          assert.ok(path?.startsWith(join(dir, 'runs', id)), path)
          if (!path) throw new Error('no stdout log')
          assert.match(await readFile(path, 'utf8'), /decimal/)
          assert.ok(md.includes(`check stdout log: ${path}`))
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

describe('shadow triage', { timeout: 300000 }, () => {
  const fake = {
    provider: 'fake' as const,
    requestedModel: null,
    requestedEffort: null,
  }
  const trigger = (
    durably: ReturnType<typeof createAgentDurably>,
    triage: boolean,
  ) =>
    durably.jobs.agentLoop.trigger({
      provider: 'fake',
      profiles: {
        code: fake,
        correctness: fake,
        'edge-cases': fake,
        ...(triage ? { triage: fake } : {}),
      },
      target: { kind: 'subject' as const },
      maxIterations: 2,
      context: 'reuse',
    })
  it('records each judgment once before code and changes nothing after it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'e2e-triage-'))
    const dir = join(home, '.local', 'state', 'local-agent-loop')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_REVIEW_SLOW_MS
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.init()
    const cases = [
      ['routine', 'routine', /fake triage: a one-line fix/],
      ['probe', 'probe', /fake triage: treat this task as risky/],
      ['invalid', 'unknown', /malformed triage: no JUDGMENT/],
      ['contradictory', 'unknown', /malformed triage: 2 JUDGMENT lines/],
      ['unsupported', 'unknown', /malformed triage: unsupported/],
      ['error', 'unknown', /triage call failed: fake triage call failed/],
    ] as const
    const ids: Record<string, string> = {}
    const decisionsOf = async (id: string) =>
      (await durably.storage.getSteps(id))
        .filter((s) => s.name.startsWith('decision:'))
        .map((s) => s.output)
    const profilesOf = async (id: string) =>
      (
        (await durably.storage.getCompletedStep(id, 'setup'))?.output as
          | { profiles: unknown }
          | undefined
      )?.profiles
    try {
      let reference: { decisions: unknown; profiles: unknown } | null = null
      let configVersion: string | null = null
      for (const [kind, judgment, reason] of cases) {
        process.env.FAKE_TRIAGE = kind
        const run = await trigger(durably, true)
        ids[kind] = run.id
        await waitFor(
          async () => (await durably.getRun(run.id))?.status === 'waiting',
          120000,
          `${kind} run reaches approval`,
        )
        // One triage call, after setup and before the first code call.
        const attempts = await durably.getStepAttempts(run.id)
        const triage = attempts.filter((a) => a.stepName === 'triage')
        assert.equal(triage.length, 1, kind)
        assert.equal(
          (triage[0]?.metadata as { role?: string } | undefined)?.role,
          'triage',
        )
        const index = (name: (n: string) => boolean) =>
          Math.min(
            ...attempts.filter((a) => name(a.stepName)).map((a) => a.stepIndex),
          )
        const at = triage[0]?.stepIndex ?? -1
        assert.ok(index((n) => n === 'setup') < at, kind)
        assert.ok(at < index((n) => n.endsWith(':code:agent')), kind)

        // Readable while the run waits for approval.
        const report = await buildReport(durably, run.id)
        assert.equal(report.triage?.judgment, judgment, kind)
        assert.match(report.triage?.reason ?? '', reason)
        assert.equal(
          report.stageUsage.find((u) => u.stage === 'triage')?.invocations,
          1,
        )
        assert.equal(
          report.roleUsage.find((u) => u.role === 'triage')?.invocations,
          1,
        )
        assert.match(
          reportToMarkdown(report),
          new RegExp(`- judgment: ${judgment}\\n- reason: `),
        )
        const json = JSON.parse(reportToJson(report)) as {
          triage: { judgment: string; reason: string }
        }
        assert.equal(json.triage.judgment, judgment)

        // The same code and review profiles and the same decisions, whatever
        // triage said.
        const observed = {
          decisions: await decisionsOf(run.id),
          profiles: await profilesOf(run.id),
        }
        reference ??= observed
        assert.deepEqual(observed, reference, kind)
        configVersion ??= report.configVersion
        assert.equal(report.configVersion, configVersion)
      }

      // Without a triage profile: no triage call, the same sequence, and a
      // different configuration version.
      const plain = await trigger(durably, false)
      ids['none'] = plain.id
      await waitFor(
        async () => (await durably.getRun(plain.id))?.status === 'waiting',
        120000,
        'run without triage reaches approval',
      )
      const plainAttempts = await durably.getStepAttempts(plain.id)
      assert.ok(!plainAttempts.some((a) => a.stepName === 'triage'))
      assert.ok(
        !plainAttempts.some(
          (a) => (a.metadata as { role?: string } | null)?.role === 'triage',
        ),
      )
      assert.deepEqual(await decisionsOf(plain.id), reference?.decisions)
      const plainReport = await buildReport(durably, plain.id)
      assert.equal(plainReport.triage, null)
      assert.ok(!plainReport.roleUsage.some((u) => u.role === 'triage'))
      assert.notEqual(plainReport.configVersion, configVersion)
      assert.match(reportToMarkdown(plainReport), /- none \(no triage profile/)

      // Finish the routine run: the judgment is kept in the run output.
      const routineId = ids['routine'] ?? ''
      const wait = (await durably.getWaits(routineId)).find((w) =>
        w.name.includes(':approve:'),
      )
      assert.ok(wait)
      await durably.signal(
        wait.id,
        {
          candidateId: (wait.metadata as { candidateId: string }).candidateId,
          decision: 'approved',
        },
        { signalId: 'triage-approve' },
      )
      await waitFor(
        async () => (await durably.getRun(routineId))?.status === 'completed',
        60000,
        'routine run completes',
      )
      const output = (await durably.getRun(routineId))?.output as {
        conclusion: string
        triage: { judgment: string }
      }
      assert.equal(output.conclusion, 'approved')
      assert.equal(output.triage.judgment, 'routine')
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_TRIAGE
    }

    const status = async (id: string) => {
      const res = await runChild(
        join(packageRoot, 'node_modules', '.bin', 'tsx'),
        [join(packageRoot, 'src', 'cli.ts'), 'status', '--run', id],
        {
          cwd: home,
          timeoutMs: 60000,
          maxOutputChars: 10_000_000,
          env: { HOME: home },
        },
      )
      assert.equal(res.code, 0, res.stderr)
      return JSON.parse(res.stdout) as {
        run: { status: string }
        triage: { judgment: string; reason: string } | null
      }
    }
    const probe = await status(ids['probe'] ?? '')
    assert.equal(probe.run.status, 'waiting')
    assert.equal(probe.triage?.judgment, 'probe')
    assert.match(probe.triage?.reason ?? '', /risky/)
    const routine = await status(ids['routine'] ?? '')
    assert.equal(routine.run.status, 'completed')
    assert.equal(routine.triage?.judgment, 'routine')
    const unknown = await status(ids['invalid'] ?? '')
    assert.equal(unknown.triage?.judgment, 'unknown')
    const none = await status(ids['none'] ?? '')
    assert.equal(none.triage, null)
  })

  it('reuses a completed triage checkpoint and stops on a start-only one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-triage-replay-'))
    process.env.FAKE_FAIL_FIRST = '0'
    // Any triage call that is actually sent fails, so a recovered judgment
    // can only have come from the checkpoint.
    process.env.FAKE_TRIAGE = 'error,error,error'
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.migrate()
    const checkpoint = async (runId: string) => {
      const checkpointsDir = join(dir, 'runs', runId, 'operation-checkpoints')
      await mkdir(checkpointsDir, { recursive: true })
      const operationKey = `${runId}/triage/agent`
      return {
        paths: checkpointPaths(checkpointsDir, operationKey),
        operationKey,
      }
    }
    try {
      const recovered = await trigger(durably, true)
      const saved = await checkpoint(recovered.id)
      const startedAt = new Date().toISOString()
      await writeFile(
        saved.paths.completed,
        `${JSON.stringify({
          operationKey: saved.operationKey,
          invocationId: 'saved-invocation',
          status: 'completed',
          invocationStartedAt: startedAt,
          invocationCompletedAt: startedAt,
          result: {
            text: 'JUDGMENT: probe\nREASON: Recorded before the worker restarted.',
            session: null,
            resolvedModel: 'fake-model',
            resolvedEffort: 'low',
            reportedModel: 'fake-model',
            reportedEffort: 'low',
            usage: null,
            elapsedMs: 5,
          },
        })}\n`,
      )
      const uncertain = await trigger(durably, true)
      const lost = await checkpoint(uncertain.id)
      await writeFile(
        lost.paths.started,
        `${JSON.stringify({
          operationKey: lost.operationKey,
          invocationId: 'lost-invocation',
          status: 'started',
          invocationStartedAt: startedAt,
        })}\n`,
      )
      await durably.init()
      await waitFor(
        async () => (await durably.getRun(recovered.id))?.status === 'waiting',
        120000,
        'recovered run reaches approval',
      )
      await waitFor(
        async () => (await durably.getRun(uncertain.id))?.status === 'failed',
        120000,
        'uncertain run stops',
      )

      const report = await buildReport(durably, recovered.id)
      // The calibration is measured from the stored task, not from the
      // call, so a recovered judgment carries it too. The sample has no
      // spec: its three values are unknown, never zero.
      assert.deepEqual(report.triage, {
        judgment: 'probe',
        reason: 'Recorded before the worker restarted.',
        calibration: {
          taskChars: [
            ...'Fix src/calc.js add() so decimal inputs are not truncated.',
          ].length,
          specChars: null,
          acceptanceCriteria: null,
          plannedFiles: null,
        },
      })
      const triage = report.attempts.filter((a) => a.stepName === 'triage')
      assert.equal(triage.length, 1)
      assert.equal(triage[0]?.measurement?.result, 'checkpoint-recovered')
      assert.equal(triage[0]?.measurement?.invocationId, 'saved-invocation')
      assert.equal(
        report.stageUsage.find((u) => u.stage === 'triage')?.invocations,
        1,
      )

      const stopped = await buildReport(durably, uncertain.id)
      assert.equal(stopped.failure?.kind, 'uncertain-invocation')
      assert.equal(stopped.triage, null)
      assert.ok(
        !stopped.attempts.some((a) => a.stepName.endsWith(':code:agent')),
      )
      // Neither run sent a triage prompt.
      assert.equal(process.env.FAKE_TRIAGE, 'error,error,error')
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_TRIAGE
    }
  })
})

describe('preflight before the first agent call', { timeout: 300000 }, () => {
  const fake = (requestedModel: string | null = null) => ({
    provider: 'fake' as const,
    requestedModel,
    requestedEffort: null,
  })
  it('stops on an unusable role before any call, and records a paid check only when the free one cannot tell', async () => {
    const home = await mkdtemp(join(tmpdir(), 'e2e-preflight-'))
    const dir = join(home, '.local', 'state', 'local-agent-loop')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_TRIAGE
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.migrate()
    const trigger = (models: {
      code?: string
      correctness?: string
      edgeCases?: string
      triage?: string
    }) =>
      durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: fake(models.code),
          correctness: fake(models.correctness),
          'edge-cases': fake(models.edgeCases),
          ...(models.triage ? { triage: fake(models.triage) } : {}),
        },
        target: { kind: 'subject' as const },
        maxIterations: 1,
        context: 'reuse',
      })
    const ids: Record<string, string> = {}
    try {
      // The free check refuses one reviewer's model: nothing is sent.
      ids['unlisted'] = (await trigger({ edgeCases: 'unlisted-model' })).id
      // The free check cannot tell about the triage model, and the minimal
      // call is refused outright.
      ids['refused'] = (await trigger({ triage: 'refused-model' })).id
      // The free check cannot tell, and the minimal call answers.
      ids['probed'] = (await trigger({ code: 'probe-model' })).id
      // Every setting is decided by the free check.
      ids['free'] = (await trigger({})).id
      // A minimal call that started and never finished, as if the worker
      // died mid-call.
      const lost = await trigger({ code: 'probe-model' })
      ids['lost'] = lost.id
      const checkpointsDir = join(dir, 'runs', lost.id, 'operation-checkpoints')
      await mkdir(checkpointsDir, { recursive: true })
      const operationKey = `${lost.id}/preflight/call:0`
      await writeFile(
        checkpointPaths(checkpointsDir, operationKey).started,
        `${JSON.stringify({
          operationKey,
          invocationId: 'lost-preflight',
          status: 'started',
          invocationStartedAt: new Date().toISOString(),
        })}\n`,
      )
      await durably.init()
      for (const [name, id] of Object.entries(ids))
        await waitFor(
          async () =>
            ['completed', 'failed', 'waiting'].includes(
              (await durably.getRun(id))?.status ?? '',
            ),
          120000,
          `${name} run settles`,
        )

      const agentSteps = async (id: string) =>
        (await durably.getStepAttempts(id))
          .map((a) => a.stepName)
          .filter((n) => n === 'triage' || n.endsWith(':agent'))
      const preflightCalls = async (id: string) =>
        (await durably.getStepAttempts(id)).filter((a) =>
          a.stepName.startsWith('preflight:call:'),
        ).length

      const unlisted = await buildReport(durably, ids['unlisted'] ?? '')
      assert.equal(unlisted.failure?.kind, 'preflight-failed')
      assert.equal(unlisted.failure?.retryable, true)
      assert.deepEqual(await agentSteps(ids['unlisted'] ?? ''), [])
      assert.equal(await preflightCalls(ids['unlisted'] ?? ''), 0)
      const refusedCheck = unlisted.preflight?.checks.find(
        (c) => c.verdict === 'unavailable',
      )
      assert.deepEqual(refusedCheck?.roles, ['edge-cases'])
      assert.equal(refusedCheck?.method, 'fake list')
      assert.equal(refusedCheck?.called, false)
      assert.equal(unlisted.preflight?.usage, null)
      assert.match(
        unlisted.failure?.details.join('\n') ?? '',
        /preflight-failed: edge-cases \(fake fake-model, effort low\) is not usable; fake list: unlisted-model/,
      )
      const md = reportToMarkdown(unlisted)
      assert.match(md, /## Preflight/)
      assert.match(
        md,
        /- edge-cases: fake fake-model effort low — unavailable by fake list \(free\)/,
      )
      assert.match(md, /- kind: preflight-failed/)

      const refused = await buildReport(durably, ids['refused'] ?? '')
      assert.equal(refused.failure?.kind, 'preflight-failed')
      assert.deepEqual(await agentSteps(ids['refused'] ?? ''), [])
      const triageCheck = refused.preflight?.checks.find((c) =>
        c.roles.includes('triage'),
      )
      assert.equal(triageCheck?.verdict, 'unavailable')
      assert.equal(triageCheck?.method, 'minimal call')
      assert.equal(triageCheck?.called, true)
      assert.match(triageCheck?.detail ?? '', /refused-model is not supported/)
      // The refused call is settled, so the run is safe to start again.
      assert.equal(refused.failure?.retryable, true)
      // Its usage is its own stage and role, never folded into another.
      assert.equal(
        refused.stageUsage.find((u) => u.stage === 'preflight')?.invocations,
        1,
      )
      assert.equal(
        refused.roleUsage.find((u) => u.role === 'preflight')?.invocations,
        1,
      )
      assert.equal(refused.preflight?.usage?.invocations, 1)
      // A refusal reports no usage: unknown, never zero.
      assert.equal(refused.preflight?.usage?.costUsd, null)

      const probed = await buildReport(durably, ids['probed'] ?? '')
      assert.equal(probed.status, 'waiting')
      assert.equal(probed.failure, null)
      assert.equal(await preflightCalls(ids['probed'] ?? ''), 1)
      assert.equal(
        probed.preflight?.checks.find((c) => c.roles.includes('code'))?.verdict,
        'available',
      )
      const json = JSON.parse(reportToJson(probed)) as {
        preflight: { checks: { method: string }[] }
      }
      assert.ok(json.preflight.checks.some((c) => c.method === 'minimal call'))

      // Free checks decide everything: no preflight call, no preflight usage.
      const free = await buildReport(durably, ids['free'] ?? '')
      assert.equal(free.status, 'waiting')
      assert.equal(await preflightCalls(ids['free'] ?? ''), 0)
      assert.ok(!free.stageUsage.some((u) => u.stage === 'preflight'))
      assert.ok(!free.roleUsage.some((u) => u.role === 'preflight'))
      assert.deepEqual(
        free.preflight?.checks.map((c) => c.roles),
        [['code', 'correctness', 'edge-cases']],
      )
      assert.match(reportToMarkdown(free), /- minimal calls: 0/)

      // A call left without an answer is not sent again.
      const lostReport = await buildReport(durably, ids['lost'] ?? '')
      assert.equal(lostReport.failure?.kind, 'uncertain-invocation')
      assert.equal(lostReport.failure?.retryable, false)
      assert.deepEqual(await agentSteps(ids['lost'] ?? ''), [])
      assert.equal(lostReport.preflight?.checks[0]?.verdict, 'unknown')
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }

    // The CLI says the same.
    const res = await runChild(
      join(packageRoot, 'node_modules', '.bin', 'tsx'),
      [join(packageRoot, 'src', 'cli.ts'), 'status'],
      { cwd: home, timeoutMs: 60000, env: { HOME: home } },
    )
    assert.equal(res.code, 0, res.stderr)
    const block = (id: string) =>
      res.stdout.split('\n\n').find((b) => b.startsWith(id)) ?? ''
    assert.match(
      block(ids['unlisted'] ?? ''),
      /preflight-failed:[\s\S]*retry: +yes/,
    )
    // A bundled-sample run has no factory.json to fix or reload.
    assert.match(
      block(ids['unlisted'] ?? ''),
      /fix the provider, model or effort of the role/,
    )
    assert.doesNotMatch(block(ids['unlisted'] ?? ''), /--reload-config/)
    assert.match(
      block(ids['lost'] ?? ''),
      /uncertain-invocation:[\s\S]*retry: +NO/,
    )
  })
})

describe(
  'baseline check before the first agent call',
  { timeout: 300000 },
  () => {
    /** A repository whose pinned check fails on its base commit. */
    async function brokenRepo(root: string): Promise<string> {
      const repo = join(root, 'repo')
      await mkdir(join(repo, 'src'), { recursive: true })
      await mkdir(join(repo, 'test'), { recursive: true })
      await writeFile(
        join(repo, 'src', 'calc.js'),
        'export function add(a, b) {\n  return Math.trunc(a) + Math.trunc(b)\n}\n',
      )
      await writeFile(
        join(repo, 'test', 'calc.test.js'),
        "import assert from 'node:assert/strict'\nimport { it } from 'node:test'\nimport { add } from '../src/calc.js'\nit('adds decimals', () => assert.equal(add(0.1, 0.2), 0.30000000000000004))\n",
      )
      await writeFile(join(repo, 'package.json'), '{"type":"module"}\n')
      for (const args of [
        ['init', '--initial-branch=main'],
        ['config', 'user.email', 'test@localhost'],
        ['config', 'user.name', 'test'],
        ['add', '-A'],
        ['commit', '-m', 'base'],
      ]) {
        const res = await runChild('git', args, { cwd: repo, timeoutMs: 30000 })
        if (res.code !== 0)
          throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
      }
      return repo
    }

    it('stops a failing base before any agent call, and skips the check when it is off', async () => {
      const home = await mkdtemp(join(tmpdir(), 'e2e-baseline-'))
      const dir = join(home, '.local', 'state', 'local-agent-loop')
      const repo = await brokenRepo(home)
      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      const durably = createAgentDurably({ stateRoot: dir })
      await durably.migrate()
      const trigger = (
        baselineCheck?: boolean,
        setupCommand: string[] | null = null,
      ) =>
        durably.jobs.agentLoop.trigger({
          provider: 'fake',
          profiles: {
            code: {
              provider: 'fake',
              requestedModel: null,
              requestedEffort: null,
            },
            correctness: {
              provider: 'fake',
              requestedModel: null,
              requestedEffort: null,
            },
            'edge-cases': {
              provider: 'fake',
              requestedModel: null,
              requestedEffort: null,
            },
            triage: {
              provider: 'fake',
              requestedModel: null,
              requestedEffort: null,
            },
          },
          target: {
            kind: 'repo' as const,
            repoPath: repo,
            baseRef: 'HEAD',
            task: 'Fix add() so decimal inputs are not truncated.',
            spec: null,
            dispositions: null,
            inputFiles: { task: null, spec: null, dispositions: null },
            issue: null,
            checkCommand: ['node', '--test', 'test/calc.test.js'],
            setupCommand,
            publish: false,
            ...(baselineCheck === undefined ? {} : { baselineCheck }),
          },
          maxIterations: 1,
          context: 'reuse',
        })
      const ids: Record<string, string> = {}
      try {
        ids['on'] = (await trigger(true)).id
        ids['off'] = (await trigger(false)).id
        ids['omitted'] = (await trigger()).id
        // Setup writes a file .gitignore does not cover.
        ids['setup'] = (
          await trigger(true, [
            'node',
            '-e',
            "require('node:fs').writeFileSync('setup.out', 'x')",
          ])
        ).id
        await durably.init()
        for (const id of Object.values(ids))
          await waitFor(
            async () =>
              ['completed', 'failed'].includes(
                (await durably.getRun(id))?.status ?? '',
              ),
            120000,
            `run ${id} settles`,
          )

        // The base fails its own check: no agent call of any kind, triage
        // included, and no preflight either.
        const on = await buildReport(durably, ids['on'] ?? '')
        assert.equal(on.status, 'failed')
        assert.equal(on.failure?.kind, 'baseline-check-failed')
        assert.equal(on.failure?.retryable, true)
        assert.match(
          on.failure?.humanCheck ?? '',
          /fix the check command or the environment/,
        )
        assert.equal(on.realLlmCallCount, 0)
        const names = on.attempts.map((a) => a.stepName)
        assert.ok(names.includes('baseline'))
        assert.ok(
          !names.some(
            (n) =>
              n === 'triage' ||
              n.startsWith('preflight') ||
              n.startsWith('stage:'),
          ),
        )
        assert.equal(on.baseline?.passed, false)
        assert.equal(on.baseline?.exitCode, 1)
        const log = on.baseline?.log
        assert.ok(log)
        assert.match(await readFile(log.stdoutPath, 'utf8'), /adds decimals/)
        assert.ok(
          log.stdoutPath.startsWith(
            join(dir, 'runs', ids['on'] ?? '', 'baseline-logs'),
          ),
        )
        const details = on.failure?.details ?? []
        assert.ok(details.includes('check exit code: 1'), details.join('\n'))
        assert.ok(details.includes(`check stdout log: ${log.stdoutPath}`))
        assert.ok(details.includes(`check stderr log: ${log.stderrPath}`))
        const md = reportToMarkdown(on)
        assert.match(
          md,
          /## Baseline check[\s\S]*- result: fail\n- exit code: 1\n- stdout: /,
        )
        assert.match(md, /- kind: baseline-check-failed/)
        const json = JSON.parse(reportToJson(on)) as {
          baseline: { exitCode: number; log: { stderrPath: string } }
          failure: { kind: string; retryable: boolean }
        }
        assert.equal(json.baseline.exitCode, 1)
        assert.equal(json.baseline.log.stderrPath, log.stderrPath)
        assert.deepEqual(
          [json.failure.kind, json.failure.retryable],
          ['baseline-check-failed', true],
        )

        // Setup left a file a passing baseline would remove: stopped before
        // the check, with that file named and its own next step.
        const setupStop = await buildReport(durably, ids['setup'] ?? '')
        assert.equal(setupStop.status, 'failed')
        assert.equal(setupStop.failure?.kind, 'baseline-check-failed')
        assert.equal(setupStop.failure?.setupUntracked, true)
        assert.match(setupStop.failure?.humanCheck ?? '', /\.gitignore/)
        assert.ok(
          setupStop.failure?.details.includes(
            'untracked setup output: setup.out',
          ),
          setupStop.failure?.details.join('\n'),
        )
        assert.equal(setupStop.realLlmCallCount, 0)
        assert.ok(
          !setupStop.attempts.some((a) => a.stepName === 'baseline'),
          'the check never ran',
        )

        // Off, or left out: the check never runs on the base, and the run goes
        // on to implement as before.
        for (const name of ['off', 'omitted']) {
          const report = await buildReport(durably, ids[name] ?? '')
          const steps = report.attempts.map((a) => a.stepName)
          assert.ok(!steps.includes('baseline'), name)
          assert.equal(report.baseline, null, name)
          assert.ok(
            steps.some((n) => n.endsWith(':code:agent')),
            name,
          )
          assert.equal(
            existsSync(join(dir, 'runs', ids[name] ?? '', 'baseline-logs')),
            false,
            name,
          )
        }
      } finally {
        await durably.stop()
        await durably.db.destroy()
        delete process.env.FAKE_FAIL_FIRST
      }

      const res = await runChild(
        join(packageRoot, 'node_modules', '.bin', 'tsx'),
        [join(packageRoot, 'src', 'cli.ts'), 'status'],
        { cwd: home, timeoutMs: 60000, env: { HOME: home } },
      )
      assert.equal(res.code, 0, res.stderr)
      const block =
        res.stdout.split('\n\n').find((b) => b.startsWith(ids['on'] ?? '')) ??
        ''
      assert.match(block, /baseline-check-failed:/)
      assert.match(block, /retry: +yes/)
      assert.match(block, /fix the check command or the environment/)
      assert.match(block, /check exit code: 1/)
      assert.match(block, /demo retrigger --run /)
    })
  },
)

describe('refused calls and the repair profile', { timeout: 300000 }, () => {
  const fake = (requestedModel: string | null = null) => ({
    provider: 'fake' as const,
    requestedModel,
    requestedEffort: null,
  })
  it('stops every refused stage as rejected-invocation, and repairs on its own profile in a new session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'e2e-rejected-'))
    const dir = join(home, '.local', 'state', 'local-agent-loop')
    delete process.env.FAKE_FAIL_FIRST
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_TRIAGE
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.migrate()
    const trigger = (args: {
      code?: string
      correctness?: string
      triage?: string
      repair?: string | null
      /** Implement iterations that leave the bug, so a repair follows. */
      failIterations?: number
      context?: 'reuse' | 'fresh'
      triageKinds?: ('routine' | 'probe' | 'invalid')[]
    }) =>
      durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: fake(args.code),
          correctness: fake(args.correctness),
          'edge-cases': fake(),
          ...(args.triage !== undefined ? { triage: fake(args.triage) } : {}),
          ...(args.repair !== undefined ? { repair: fake(args.repair) } : {}),
        },
        target: { kind: 'subject' as const },
        maxIterations: 2,
        context: args.context ?? 'reuse',
        fakeScenario: {
          failIterations: args.failIterations ?? 0,
          ...(args.triageKinds ? { triage: args.triageKinds } : {}),
        },
      })
    const ids: Record<string, string> = {}
    try {
      ids['implement'] = (
        await trigger({ code: 'rejects-code', triage: 'triage-model' })
      ).id
      ids['review'] = (await trigger({ correctness: 'rejects-review' })).id
      ids['triage'] = (await trigger({ triage: 'rejects-triage' })).id
      ids['repair'] = (
        await trigger({ repair: 'rejects-repair', failIterations: 1 })
      ).id
      ids['omitted'] = (await trigger({ failIterations: 1 })).id
      ids['same'] = (await trigger({ repair: null, failIterations: 1 })).id
      ids['separate'] = (
        await trigger({ repair: 'repair-model', failIterations: 1 })
      ).id
      ids['fresh'] = (await trigger({ context: 'fresh', failIterations: 1 })).id
      ids['fresh-separate'] = (
        await trigger({
          context: 'fresh',
          repair: 'repair-model',
          failIterations: 1,
        })
      ).id
      for (const kind of ['routine', 'probe', 'invalid'] as const)
        ids[`judged-${kind}`] = (
          await trigger({
            triage: 'triage-model',
            repair: 'repair-model',
            failIterations: 1,
            triageKinds: [kind],
          })
        ).id
      await durably.init()
      for (const [name, id] of Object.entries(ids))
        await waitFor(
          async () =>
            ['completed', 'failed', 'waiting'].includes(
              (await durably.getRun(id))?.status ?? '',
            ),
          120000,
          `${name} run settles`,
        )

      // Every refused stage stops the same way: settled, safe to retry, with
      // the provider's reason, and the call was sent once.
      for (const [name, role] of [
        ['implement', 'implement'],
        ['review', 'review-a'],
        ['triage', 'triage'],
        ['repair', 'repair'],
      ] as const) {
        const id = ids[name] ?? ''
        const report = await buildReport(durably, id)
        assert.equal(report.status, 'failed', name)
        assert.equal(report.failure?.kind, 'rejected-invocation', name)
        assert.equal(report.failure?.retryable, true, name)
        assert.ok(
          report.failure?.details.includes(
            `refusal: fake: the ${role} call on rejects-${name === 'implement' ? 'code' : name} is refused`,
          ),
          `${name}: ${report.failure?.details.join('\n')}`,
        )
        const refused = report.attempts.filter(
          (a) =>
            a.measurement?.role === role && a.measurement.result === 'rejected',
        )
        assert.equal(refused.length, 1, name)
        const key = refused[0]?.measurement?.operationKey ?? ''
        const paths = checkpointPaths(
          join(dir, 'runs', id, 'operation-checkpoints'),
          key,
        )
        const saved = JSON.parse(await readFile(paths.completed, 'utf8')) as {
          status: string
          rejection?: string
        }
        assert.equal(saved.status, 'completed', name)
        assert.match(saved.rejection ?? '', /is refused/, name)
        // The sample reads no factory.json, so no reload is offered.
        assert.ok(
          !report.failure?.next.some((n) => n.includes('--reload-config')),
          name,
        )
        assert.match(reportToMarkdown(report), /- kind: rejected-invocation/)
      }
      // A refused triage stops the run instead of recording `unknown`.
      const triageStop = await buildReport(durably, ids['triage'] ?? '')
      assert.equal(triageStop.triage, null)
      assert.ok(
        !triageStop.attempts.some((a) => a.stepName.endsWith(':code:agent')),
      )

      /** The implement and repair calls, in order, as the report has them. */
      const codeCalls = async (name: string) =>
        (await buildReport(durably, ids[name] ?? '')).attempts
          .filter((a) => a.stepName.endsWith(':code:agent') && a.measurement)
          .map((a) => ({
            role: a.measurement?.role,
            session: a.measurement?.sessionId,
            model: a.measurement?.requestedModel,
          }))

      // Without a repair profile, or with one equal to code's, reuse keeps
      // one session on the code profile.
      for (const name of ['omitted', 'same']) {
        const [implement, repair] = await codeCalls(name)
        assert.equal(repair?.role, 'repair', name)
        assert.equal(repair?.session, implement?.session, name)
        assert.equal(repair?.model, null, name)
      }
      // A different repair profile repairs on it, in a new session.
      const [implement, repair] = await codeCalls('separate')
      assert.equal(repair?.role, 'repair')
      assert.equal(repair?.model, 'repair-model')
      assert.notEqual(repair?.session, implement?.session)
      // Fresh starts a new session for every repair, with or without one.
      for (const name of ['fresh', 'fresh-separate']) {
        const [first, second] = await codeCalls(name)
        assert.notEqual(second?.session, first?.session, name)
      }

      // The repair profile is preflighted once per distinct setting.
      const separate = await buildReport(durably, ids['separate'] ?? '')
      assert.deepEqual(
        separate.preflight?.checks.map((c) => c.roles),
        [['code', 'correctness', 'edge-cases'], ['repair']],
      )
      const same = await buildReport(durably, ids['same'] ?? '')
      assert.deepEqual(
        same.preflight?.checks.map((c) => c.roles),
        [['code', 'correctness', 'edge-cases', 'repair']],
      )
      // Repair calls and usage are their own role, never code's.
      for (const report of [separate, same]) {
        const role = (name: string) =>
          report.roleUsage.find((u) => u.role === name)
        assert.equal(role('code')?.invocations, 1)
        assert.equal(role('repair')?.invocations, 1)
      }
      assert.equal(
        separate.roleUsage.find((u) => u.role === 'repair')?.requestedModel,
        'repair-model',
      )
      // An equal repair profile keeps the version a run without one has; a
      // different one does not.
      const omitted = await buildReport(durably, ids['omitted'] ?? '')
      assert.equal(same.configVersion, omitted.configVersion)
      assert.notEqual(separate.configVersion, omitted.configVersion)

      // The judgment is recorded and routes nothing: the same steps, roles
      // and models whatever it says.
      const path = async (name: string) =>
        (await buildReport(durably, ids[name] ?? '')).attempts
          .filter((a) => a.stepName !== 'triage')
          .map((a) =>
            [
              a.stepName,
              a.measurement?.role ?? '',
              a.measurement?.requestedModel ?? '',
            ].join('/'),
          )
      const routine = await path('judged-routine')
      assert.deepEqual(await path('judged-probe'), routine)
      assert.deepEqual(await path('judged-invalid'), routine)
      const judged = await buildReport(durably, ids['judged-invalid'] ?? '')
      assert.equal(judged.triage?.judgment, 'unknown')
      assert.equal(judged.triage?.calibration?.specChars, null)

      // The open run reads the calibration from its triage step; once it
      // finishes, from its output. Both are the same record.
      const openRun = ids['judged-routine'] ?? ''
      const before = await buildReport(durably, openRun)
      const calibration = {
        taskChars: [
          ...'Fix src/calc.js add() so decimal inputs are not truncated.',
        ].length,
        specChars: null,
        acceptanceCriteria: null,
        plannedFiles: null,
      }
      assert.deepEqual(before.triage?.calibration, calibration)
      assert.match(
        reportToMarkdown(before),
        /- task characters: 58\n- spec characters: unknown/,
      )
      const wait = (await durably.getWaits(openRun)).find((w) =>
        w.name.includes(':approve:'),
      )
      assert.ok(wait)
      await durably.signal(
        wait.id,
        {
          candidateId: (wait.metadata as { candidateId: string }).candidateId,
          decision: 'approved',
        },
        { signalId: 'approve-judged-routine' },
      )
      await waitFor(
        async () => (await durably.getRun(openRun))?.status === 'completed',
        60000,
        'the approved run finishes',
      )
      const after = await buildReport(durably, openRun)
      assert.deepEqual(
        (after.output as { triage?: { calibration?: unknown } }).triage
          ?.calibration,
        calibration,
      )
      assert.deepEqual(after.triage, before.triage)

      // Compare sets the calibration and the stop beside the judgment,
      // with unknown values counted as unknown.
      const stopped = await buildReport(durably, ids['implement'] ?? '')
      assert.equal(stopped.triage?.judgment, 'routine')
      const [row] = compareReports([stopped]).groups[0]?.triage ?? []
      assert.deepEqual(row?.stops, { 'rejected-invocation': 1 })
      assert.equal(row?.calibration.taskChars.median, 58)
      assert.deepEqual(
        [row?.calibration.specChars.n, row?.calibration.specChars.unknown],
        [0, 1],
      )
      const md = comparisonToMarkdown(compareReports([stopped]))
      assert.match(md, /\| rejected-invocation 1 \|/)
      assert.match(
        md,
        /\| routine \| 58 \[58\.\.58\] \(n=1\) \| unknown \(1 unknown\) \|/,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }

    // The CLI status names the refusal and says it is safe to retry.
    const res = await runChild(
      join(packageRoot, 'node_modules', '.bin', 'tsx'),
      [join(packageRoot, 'src', 'cli.ts'), 'status'],
      { cwd: home, timeoutMs: 60000, env: { HOME: home } },
    )
    assert.equal(res.code, 0, res.stderr)
    const block =
      res.stdout.split('\n\n').find((b) => b.startsWith(ids['review'] ?? '')) ??
      ''
    assert.match(block, /rejected-invocation:[\s\S]*retry: +yes/)
    assert.match(
      block,
      /refusal: fake: the review-a call on rejects-review is refused/,
    )
    assert.match(block, /demo retrigger --run /)
  })

  it('hands a new repair session the task, the spec and the repair notes', () => {
    const prompt = codePrompt({
      role: 'repair',
      iteration: 2,
      repairNotes: ['acceptance: add(0.1, 0.2) returned 0'],
      task: 'Carry out the work described in the untrusted TASK block below, as specified by the SPEC block.',
      rules: ['Keep the change minimal.'],
      untrusted: [
        { label: 'TASK', content: 'Fix add().' },
        { label: 'SPEC', content: 'add() returns the exact sum.' },
      ],
      newSession: true,
    })
    assert.match(prompt, /starting a new session \(iteration 2\)/)
    assert.doesNotMatch(prompt, /continuing the/)
    assert.match(prompt, /Fix add\(\)\./)
    assert.match(prompt, /add\(\) returns the exact sum\./)
    assert.match(
      prompt,
      /Verified feedback to address:\n- acceptance: add\(0\.1, 0\.2\) returned 0/,
    )
  })
})

describe('triage calibration counting', () => {
  it('counts the task and spec in code points, and unknown without a spec', () => {
    assert.deepEqual(triageCalibration('直して ok', null), {
      taskChars: 6,
      specChars: null,
      acceptanceCriteria: null,
      plannedFiles: null,
    })
  })

  it('counts top-level items under the named headings once each', () => {
    const spec = [
      '# Feature',
      '',
      '## Files to Change',
      '',
      '- `src/a.ts` — the parser.',
      '- `src/a.ts` — named again, counted once.',
      '* src/b.ts: the writer',
      '  - `src/c.ts` nested under b, not its own item',
      '1. `docs/x.md`',
      '',
      '## Completion Criteria',
      '',
      '- [ ] parses a heading',
      '- [x] Parses   a heading',
      '- counts once',
      '',
      '### Edge cases',
      '',
      '- a subheading belongs to its section',
      '',
      '```md',
      '## Acceptance criteria',
      '- inside a fence, never counted',
      '```',
      '',
      '## Out of Scope',
      '',
      '- not a criterion',
      '',
      '## 受け入れ基準:',
      '',
      '- 見出しが別でも同じ規則で数える',
    ].join('\n')
    const c = triageCalibration('task', spec)
    assert.equal(c.specChars, [...spec].length)
    // parses a heading (twice, once after normalizing), counts once, the
    // subheading's item, and the Japanese section's item.
    assert.equal(c.acceptanceCriteria, 4)
    // src/a.ts, src/b.ts, docs/x.md; src/c.ts is nested.
    assert.equal(c.plannedFiles, 3)
  })

  it('leaves a count unknown when the spec has no section for it', () => {
    const c = triageCalibration('task', '# Plan\n\n- just prose items\n')
    assert.equal(c.specChars, [...'# Plan\n\n- just prose items\n'].length)
    assert.equal(c.acceptanceCriteria, null)
    assert.equal(c.plannedFiles, null)
  })
})
