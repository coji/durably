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
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { signalApproval } from '../src/approval.js'
import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { compareReports, comparisonToMarkdown } from '../src/engine/compare.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AttemptMeasurement,
} from '../src/engine/providers/types.js'
import {
  reportToJson,
  reportToMarkdown,
  triageCalibration,
} from '../src/engine/report.js'
import { checkpointPaths } from '../src/engine/runner.js'
import type { ResolvedProfile, SessionRef } from '../src/engine/types.js'
import { configVersionOf } from '../src/engine/versions.js'
import {
  BASELINE_INDEX_KEEP,
  type BaselineStore,
  baselineIdentityOf,
  recordBaselineInIndex,
  reusedBaseline,
  validReusable,
} from '../src/factory/baseline-reuse.js'
import { resolveTimeouts } from '../src/factory/job.js'
import { codePrompt } from '../src/factory/prompts.js'
import { codeStage } from '../src/factory/stages.js'
import {
  EFFORT_RESUME_POLICY,
  initialState,
  type BaselineIdentity,
  type BaselineRecord,
  REPAIR_SESSION_STEP,
  type RepairSessionRecord,
  type FactorySetup,
  type FactoryState,
} from '../src/factory/types.js'

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

    /**
     * A repository whose pinned check passes and records the commit it ran
     * on, and whose setup records each run and, when asked through a flag
     * file, leaves an untracked file or edits a tracked one.
     */
    async function passingRepo(root: string) {
      const repo = join(root, 'repo')
      const checks = join(root, 'checks.log')
      const setups = join(root, 'setups.log')
      const untrackedFlag = join(root, 'leave-untracked')
      const trackedFlag = join(root, 'edit-tracked')
      await mkdir(join(repo, 'src'), { recursive: true })
      await writeFile(
        join(repo, 'src', 'calc.js'),
        'export function add(a, b) {\n  return a + b\n}\n',
      )
      await writeFile(
        join(repo, 'check.mjs'),
        "import { execFileSync } from 'node:child_process'\nimport { appendFileSync } from 'node:fs'\nconst head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()\nappendFileSync(process.argv[2], head + '\\n')\n",
      )
      await writeFile(
        join(repo, 'setup.mjs'),
        "import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\nconst [log, untracked, tracked] = process.argv.slice(2)\nappendFileSync(log, 'setup\\n')\nif (existsSync(untracked)) writeFileSync('setup.out', 'x')\nif (existsSync(tracked)) appendFileSync('src/calc.js', '// setup\\n')\n",
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
      const head = await runChild('git', ['rev-parse', 'HEAD'], {
        cwd: repo,
        timeoutMs: 30000,
      })
      return {
        repo,
        base: head.stdout.trim(),
        checkCommand: ['node', 'check.mjs', checks],
        setupCommand: ['node', 'setup.mjs', setups, untrackedFlag, trackedFlag],
        untrackedFlag,
        trackedFlag,
        /** Lines each log holds: one per check or setup that ran. */
        lines: async (which: 'checks' | 'setups') => {
          const file = which === 'checks' ? checks : setups
          return existsSync(file)
            ? (await readFile(file, 'utf8')).split('\n').filter(Boolean)
            : []
        },
      }
    }

    it('reuses a matching passing result after setup, and runs the check otherwise', async () => {
      const home = await mkdtemp(join(tmpdir(), 'e2e-baseline-reuse-'))
      const dir = join(home, '.local', 'state', 'local-agent-loop')
      const fixture = await passingRepo(home)
      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      const durably = createAgentDurably({ stateRoot: dir })
      await durably.init()
      const fake = {
        provider: 'fake' as const,
        requestedModel: null,
        requestedEffort: null,
      }
      const start = async (args: {
        baselineCheck?: boolean
        reuse?: { maxAgeMs: number }
        autoApprove?: boolean
        checkTimeoutMs?: number
      }) =>
        (
          await durably.jobs.agentLoop.trigger({
            provider: 'fake',
            profiles: { code: fake, correctness: fake, 'edge-cases': fake },
            target: {
              kind: 'repo' as const,
              repoPath: fixture.repo,
              baseRef: 'HEAD',
              task: 'Add a note.',
              spec: null,
              dispositions: null,
              inputFiles: { task: null, spec: null, dispositions: null },
              issue: null,
              publish: false,
              checkCommand: fixture.checkCommand,
              setupCommand: fixture.setupCommand,
              baselineCheck: args.baselineCheck ?? true,
              ...(args.reuse ? { baselineReuse: args.reuse } : {}),
            },
            maxIterations: 1,
            context: 'reuse',
            ...(args.autoApprove === false ? { autoApprove: false } : {}),
            ...(args.checkTimeoutMs
              ? { checkTimeoutMs: args.checkTimeoutMs }
              : {}),
            fakeScenario: { changes: { 'NOTE.md': 'note\n' } },
          })
        ).id
      const settle = async (id: string, statuses = ['completed', 'failed']) => {
        await waitFor(
          async () =>
            statuses.includes((await durably.getRun(id))?.status ?? ''),
          120000,
          `run ${id} settles`,
        )
        return (await durably.getRun(id))?.status
      }
      // Checks that ran on the base commit, not on a candidate.
      const baseChecks = async () =>
        (await fixture.lines('checks')).filter((h) => h === fixture.base).length
      const reuse = { maxAgeMs: 600_000 }
      try {
        // The first run has nothing to reuse: it runs the check.
        const first = await start({ reuse })
        assert.equal(await settle(first), 'completed')
        assert.equal(await baseChecks(), 1)
        const firstReport = await buildReport(durably, first)
        assert.equal(firstReport.baseline?.passed, true)
        assert.equal(firstReport.baseline?.reusedFrom, null)
        assert.match(
          reportToMarkdown(firstReport),
          /## Baseline check[\s\S]*- source: measured in this run/,
        )
        const firstStep = await durably.storage.getCompletedStep(
          first,
          'baseline',
        )
        // The check's own completion, from its checkpoint.
        const checkedAt = (firstStep?.output as { checkedAt?: string } | null)
          ?.checkedAt
        assert.ok(checkedAt)
        assert.ok(
          Date.parse(checkedAt) <= Date.parse(firstStep?.completedAt ?? ''),
        )
        // The measured pass is indexed under its identity.
        const indexDir = join(dir, 'baseline-index')
        // One directory per identity, one file per run.
        const [identityDir] = await readdir(indexDir)
        assert.ok(identityDir)
        const entriesDir = join(indexDir, identityDir)
        const indexEntries = async () =>
          Promise.all(
            (await readdir(entriesDir))
              .filter((f) => f.endsWith('.json'))
              .map(
                async (f) =>
                  JSON.parse(await readFile(join(entriesDir, f), 'utf8')) as {
                    runId: string
                    checkedAt: string
                  },
              ),
          )
        assert.deepEqual(
          (await indexEntries()).map((e) => [e.runId, e.checkedAt]),
          [[first, checkedAt]],
        )

        // A matching run sets up, and uses the first result in place of
        // the check, without reading the run history. It waits for
        // approval, to be replayed later.
        let historyReads = 0
        const getRuns = durably.getRuns
        const storageGetRuns = durably.storage.getRuns
        durably.getRuns = ((...args: Parameters<typeof getRuns>) => {
          historyReads++
          return getRuns(...args)
        }) as typeof getRuns
        durably.storage.getRuns = ((
          ...args: Parameters<typeof storageGetRuns>
        ) => {
          historyReads++
          return storageGetRuns(...args)
        }) as typeof storageGetRuns
        let reused: string
        try {
          reused = await start({ reuse, autoApprove: false })
          assert.equal(await settle(reused, ['waiting', 'failed']), 'waiting')
        } finally {
          durably.getRuns = getRuns
          durably.storage.getRuns = storageGetRuns
        }
        assert.equal(historyReads, 0, 'the lookup did not read the history')
        assert.equal(await baseChecks(), 1, 'the check did not run')
        // A reused result is not indexed.
        assert.deepEqual(
          (await indexEntries()).map((e) => e.runId),
          [first],
        )
        assert.equal((await fixture.lines('setups')).length, 2)
        assert.equal(
          existsSync(join(dir, 'runs', reused, 'baseline-logs')),
          false,
        )

        // Left out: the check runs, and the config version is the same.
        const omitted = await start({})
        assert.equal(await settle(omitted), 'completed')
        assert.equal(await baseChecks(), 2)
        const omittedReport = await buildReport(durably, omitted)
        assert.equal(omittedReport.baseline?.reusedFrom, null)
        assert.equal(omittedReport.configVersion, firstReport.configVersion)

        // Replayed after approval: the completed baseline step is read
        // back, still naming the first run although a newer result exists,
        // and the check does not run.
        const wait = (await durably.getWaits(reused)).find((w) =>
          w.name.includes(':approve:'),
        )
        assert.ok(wait)
        await signalApproval(durably, reused, wait.id, 'approved')
        assert.equal(await settle(reused), 'completed')
        assert.equal(await baseChecks(), 2)
        const report = await buildReport(durably, reused)
        assert.equal(report.baseline?.passed, true)
        assert.deepEqual(report.baseline?.reusedFrom, {
          runId: first,
          checkedAt,
        })
        assert.equal(report.baseline?.recovered, false)
        assert.equal(
          report.baseline?.log?.stdoutPath,
          firstReport.baseline?.log?.stdoutPath,
        )
        assert.equal(report.configVersion, firstReport.configVersion)
        const md = reportToMarkdown(report)
        assert.ok(
          md.includes(
            `- source: reused from run ${first}, checked at ${checkedAt}; the check did not run in this run`,
          ),
          md,
        )
        const json = JSON.parse(reportToJson(report)) as {
          baseline: { reusedFrom: { runId: string; checkedAt: string } }
        }
        assert.deepEqual(json.baseline.reusedFrom, {
          runId: first,
          checkedAt,
        })

        // The source's stdout removed, stderr still present: missing either
        // one counts as missing, and the reason names the removed path.
        const sourceStdoutPath = firstReport.baseline?.log?.stdoutPath
        const sourceStderrPath = firstReport.baseline?.log?.stderrPath
        assert.ok(sourceStdoutPath)
        assert.ok(sourceStderrPath)
        await rm(sourceStdoutPath, { force: true })
        const stdoutGone = await buildReport(durably, reused)
        assert.equal(stdoutGone.baseline?.log, null)
        assert.match(stdoutGone.baseline?.logMissing ?? '', /no longer at/)
        assert.match(
          stdoutGone.baseline?.logMissing ?? '',
          new RegExp(sourceStdoutPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        )
        assert.match(
          reportToMarkdown(stdoutGone),
          /- log: none \(the log of run /,
        )
        const stdoutGoneJson = JSON.parse(reportToJson(stdoutGone)) as {
          baseline: { log: null; logMissing: string }
        }
        assert.equal(stdoutGoneJson.baseline.log, null)
        assert.match(stdoutGoneJson.baseline.logMissing, /no longer at/)

        // Restore stdout, then remove only stderr: still missing, and the
        // reason now names the stderr path instead.
        await writeFile(sourceStdoutPath, 'restored stdout\n')
        await rm(sourceStderrPath, { force: true })
        const stderrGone = await buildReport(durably, reused)
        assert.equal(stderrGone.baseline?.log, null)
        assert.match(stderrGone.baseline?.logMissing ?? '', /no longer at/)
        assert.match(
          stderrGone.baseline?.logMissing ?? '',
          new RegExp(sourceStderrPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        )
        assert.match(
          reportToMarkdown(stderrGone),
          /- log: none \(the log of run /,
        )
        const stderrGoneJson = JSON.parse(reportToJson(stderrGone)) as {
          baseline: { log: null; logMissing: string }
        }
        assert.equal(stderrGoneJson.baseline.log, null)
        assert.match(stderrGoneJson.baseline.logMissing, /no longer at/)

        // The source's log directory removed entirely: no log, and why.
        await rm(join(dir, 'runs', first, 'baseline-logs'), {
          recursive: true,
          force: true,
        })
        const gone = await buildReport(durably, reused)
        assert.equal(gone.baseline?.log, null)
        assert.match(gone.baseline?.logMissing ?? '', /no longer at/)
        assert.match(reportToMarkdown(gone), /- log: none \(the log of run /)

        // An index entry whose run's step no longer matches is skipped: here
        // it names the reusing run, whose result is not a measurement, and
        // it is the only one left, so the check runs.
        for (const f of await readdir(entriesDir))
          await rm(join(entriesDir, f), { force: true })
        await writeFile(
          join(entriesDir, `${reused}.json`),
          `${JSON.stringify({ runId: reused, checkedAt: new Date().toISOString() })}\n`,
        )
        const stale = await start({ reuse })
        assert.equal(await settle(stale), 'completed')
        assert.equal(await baseChecks(), 3)
        assert.equal(
          (await buildReport(durably, stale)).baseline?.reusedFrom,
          null,
        )

        // Too old, or another check timeout: the check runs.
        const expired = await start({ reuse: { maxAgeMs: 1 } })
        assert.equal(await settle(expired), 'completed')
        assert.equal(await baseChecks(), 4)
        const timeout = await start({ reuse, checkTimeoutMs: 120_000 })
        assert.equal(await settle(timeout), 'completed')
        assert.equal(await baseChecks(), 5)
        for (const id of [expired, timeout])
          assert.equal(
            (await buildReport(durably, id)).baseline?.reusedFrom,
            null,
          )

        // Off: no baseline, whatever baselineReuse says.
        const off = await start({ baselineCheck: false, reuse })
        assert.equal(await settle(off), 'completed')
        const offReport = await buildReport(durably, off)
        assert.equal(offReport.baseline, null)
        assert.ok(!offReport.attempts.some((a) => a.stepName === 'baseline'))
        assert.equal(await baseChecks(), 5)

        // A matching result does not excuse setup's leftovers: an untracked
        // file stops the run in setup, and a tracked edit in the baseline
        // step, both before any agent call and without the check.
        await writeFile(fixture.untrackedFlag, '')
        const untracked = await start({ reuse })
        assert.equal(await settle(untracked), 'failed')
        await rm(fixture.untrackedFlag)
        await writeFile(fixture.trackedFlag, '')
        const tracked = await start({ reuse })
        assert.equal(await settle(tracked), 'failed')
        await rm(fixture.trackedFlag)
        for (const id of [untracked, tracked]) {
          const stopped = await buildReport(durably, id)
          assert.equal(stopped.failure?.kind, 'baseline-check-failed')
          assert.ok(
            !stopped.attempts.some(
              (a) =>
                a.stepName.startsWith('preflight') ||
                a.stepName.startsWith('stage:'),
            ),
            id,
          )
        }
        assert.equal(
          (await buildReport(durably, untracked)).failure?.setupUntracked,
          true,
        )
        assert.match(
          (await durably.getRun(tracked))?.error ?? '',
          /baseline-mutated: setup left uncommitted changes to tracked files/,
        )
        assert.equal(await baseChecks(), 5)
      } finally {
        await durably.stop()
        await durably.db.destroy()
        delete process.env.FAKE_FAIL_FIRST
      }
    })

    it("records a resumed check's own completion time, and indexes it under that time", async () => {
      const home = await mkdtemp(join(tmpdir(), 'e2e-baseline-resume-'))
      const dir = join(home, '.local', 'state', 'local-agent-loop')
      const fixture = await passingRepo(home)
      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      const durably = createAgentDurably({ stateRoot: dir })
      await durably.migrate()
      const fake = {
        provider: 'fake' as const,
        requestedModel: null,
        requestedEffort: null,
      }
      try {
        const { id } = await durably.jobs.agentLoop.trigger({
          provider: 'fake',
          profiles: { code: fake, correctness: fake, 'edge-cases': fake },
          target: {
            kind: 'repo' as const,
            repoPath: fixture.repo,
            baseRef: 'HEAD',
            task: 'Add a note.',
            spec: null,
            dispositions: null,
            inputFiles: { task: null, spec: null, dispositions: null },
            issue: null,
            publish: false,
            checkCommand: fixture.checkCommand,
            setupCommand: fixture.setupCommand,
            baselineCheck: true,
            baselineReuse: { maxAgeMs: 600_000 },
          },
          maxIterations: 1,
          context: 'reuse',
          fakeScenario: { changes: { 'NOTE.md': 'note\n' } },
        })
        // The check completed before the worker died, and the step was
        // never saved: the resume reads the verdict back from the
        // checkpoint, and its time is the check's, not the resume's.
        const checkpointsDir = join(dir, 'runs', id, 'operation-checkpoints')
        await mkdir(checkpointsDir, { recursive: true })
        const operationKey = `${id}/baseline`
        const checkedAt = new Date(Date.now() - 120_000).toISOString()
        await writeFile(
          checkpointPaths(checkpointsDir, operationKey).completed,
          `${JSON.stringify({
            operationKey,
            invocationId: 'before-restart',
            invocationStartedAt: checkedAt,
            invocationCompletedAt: checkedAt,
            result: { passed: true, stdout: 'ok', exitCode: 0, log: null },
            elapsedMs: 5,
          })}\n`,
        )
        await durably.init()
        await waitFor(
          async () =>
            ['completed', 'failed'].includes(
              (await durably.getRun(id))?.status ?? '',
            ),
          120000,
          'resumed run settles',
        )
        assert.equal((await durably.getRun(id))?.status, 'completed')
        assert.deepEqual(
          (await fixture.lines('checks')).filter((h) => h === fixture.base),
          [],
          'the check did not run again',
        )
        const output = (await durably.storage.getCompletedStep(id, 'baseline'))
          ?.output as { checkedAt?: string; source?: string } | undefined
        assert.equal(output?.source, 'measured')
        assert.equal(output?.checkedAt, checkedAt)
        const indexDir = join(dir, 'baseline-index')
        const [identityDir] = await readdir(indexDir)
        assert.ok(identityDir)
        assert.deepEqual(
          JSON.parse(
            await readFile(join(indexDir, identityDir, `${id}.json`), 'utf8'),
          ),
          { runId: id, checkedAt },
        )
      } finally {
        await durably.stop()
        await durably.db.destroy()
        delete process.env.FAKE_FAIL_FIRST
      }
    })
  },
)

describe('choosing a baseline result to reuse', () => {
  const identity: BaselineIdentity = {
    repoPath: '/repo',
    baseCommit: 'a'.repeat(40),
    checkCommand: ['pnpm', 'validate'],
    setupCommand: ['pnpm', 'install'],
    checkTimeoutMs: 900000,
    node: 'v24.0.0',
    platform: 'darwin',
    arch: 'arm64',
    checkExecutable: '/usr/local/bin/pnpm',
  }
  const now = Date.parse('2026-09-27T12:00:00.000Z')
  const at = (msAgo: number) => new Date(now - msAgo).toISOString()
  const measured = (over: Partial<BaselineIdentity> = {}, passed = true) => ({
    source: 'measured',
    passed,
    stdout: 'ok',
    exitCode: passed ? 0 : 1,
    log: null,
    identity: { ...identity, ...over },
  })
  const valid = (runId: string, output: unknown, completedAt: string | null) =>
    validReusable({
      runId: 'current',
      identity,
      maxAgeMs: 60_000,
      now,
      source: { runId, output, completedAt },
    })?.runId ?? null

  it('takes a measured, passing, matching result within the age', () => {
    assert.equal(valid('recent', measured(), at(10_000)), 'recent')
    assert.equal(valid('edge', measured(), at(60_000)), 'edge')
  })

  it("ages a result from its check's completion, not its step's", () => {
    // Checked long ago, its step saved only now on a resume: too old.
    assert.equal(
      valid('resumed', { ...measured(), checkedAt: at(60_001) }, at(0)),
      null,
    )
    const chosen = validReusable({
      runId: 'current',
      identity,
      maxAgeMs: 60_000,
      now,
      source: {
        runId: 'resumed',
        output: { ...measured(), checkedAt: at(30_000) },
        completedAt: at(0),
      },
    })
    assert.equal(chosen?.checkedAt, at(30_000))
    assert.equal('checkedAt' in (chosen?.record ?? {}), false)
  })

  it('never takes a failed, reused, older, unfinished, expired or future result, or its own', () => {
    const { identity: _i, ...legacy } = measured()
    for (const [runId, output, completedAt] of [
      ['failed', measured({}, false), at(1000)],
      ['reused', { ...measured(), source: 'reused' }, at(1000)],
      ['legacy', legacy, at(1000)],
      ['older-format', { passed: true, stdout: '', exitCode: 0 }, at(1000)],
      ['no-identity', { ...measured(), identity: null }, at(1000)],
      ['unfinished', measured(), null],
      ['expired', measured(), at(60_001)],
      ['future', measured(), new Date(now + 1).toISOString()],
      ['current', measured(), at(1000)],
    ] as const)
      assert.equal(valid(runId, output, completedAt), null, runId)
  })

  it('never takes a result from another repository, base, setup, check or environment', () => {
    for (const over of [
      { repoPath: '/other' },
      { baseCommit: 'b'.repeat(40) },
      { checkCommand: ['pnpm', 'test'] },
      { setupCommand: null },
      { setupCommand: ['pnpm', 'install', '--frozen-lockfile'] },
      { checkTimeoutMs: 600000 },
      { node: 'v24.1.0' },
      { platform: 'linux' },
      { arch: 'x64' },
      { checkExecutable: '/opt/homebrew/bin/pnpm' },
    ] satisfies Partial<BaselineIdentity>[])
      assert.equal(
        valid('other', measured(over), at(1000)),
        null,
        JSON.stringify(over),
      )
  })

  const record = (over: Partial<BaselineRecord> = {}): BaselineRecord => ({
    passed: true,
    stdout: 'ok',
    exitCode: 0,
    log: null,
    source: 'measured',
    identity,
    checkedAt: at(30_000),
    ...over,
  })
  /** Every entry under the index, as [runId, checkedAt], newest first. */
  const entriesOf = async (stateRoot: string) => {
    const root = join(stateRoot, 'baseline-index')
    if (!existsSync(root)) return []
    const found: [string, string][] = []
    for (const id of await readdir(root))
      for (const f of await readdir(join(root, id))) {
        const e = JSON.parse(await readFile(join(root, id, f), 'utf8')) as {
          runId: string
          checkedAt: string
        }
        found.push([e.runId, e.checkedAt])
      }
    return found.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
  }

  it('indexes only measured passes, one file per run, never overwriting another', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-index-'))
    const write = (runId: string, r: BaselineRecord) =>
      recordBaselineInIndex({ stateRoot, runId, record: r, now })
    await write('failed', record({ passed: false, exitCode: 1 }))
    await write('no-identity', record({ identity: null }))
    await write('no-time', record({ checkedAt: undefined }))
    await write(
      'reused',
      record({
        source: 'reused',
        reusedFrom: { runId: 'x', checkedAt: at(1000), recovered: false },
      }),
    )
    assert.deepEqual(await entriesOf(stateRoot), [])
    await write('measured', record())
    // Written after, but older: both are kept, and neither replaces the
    // other, whichever order concurrent writers finish in.
    await write('older', record({ checkedAt: at(40_000) }))
    await write('newer', record({ checkedAt: at(10_000) }))
    // A replay rewrites only its own file.
    await write('measured', record())
    assert.deepEqual(await entriesOf(stateRoot), [
      ['newer', at(10_000)],
      ['measured', at(30_000)],
      ['older', at(40_000)],
    ])
    // Another identity has its own directory.
    await write('other', record({ identity: { ...identity, node: 'v25.0.0' } }))
    assert.equal((await readdir(join(stateRoot, 'baseline-index'))).length, 2)
  })

  it(`prunes to the newest ${BASELINE_INDEX_KEEP} entries by checkedAt, and drops only unparsable ones`, async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-index-prune-'))
    for (let i = 0; i < BASELINE_INDEX_KEEP + 5; i++)
      await recordBaselineInIndex({
        stateRoot,
        runId: `run-${i}`,
        record: record({ checkedAt: at((BASELINE_INDEX_KEEP + 5 - i) * 1000) }),
        now,
      })
    const [dir] = await readdir(join(stateRoot, 'baseline-index'))
    assert.ok(dir)
    const idDir = join(stateRoot, 'baseline-index', dir)
    // Dated in the future by a clock set back, or by a writer from
    // elsewhere: still kept, since it is among the newest by checkedAt.
    await writeFile(
      join(idDir, 'future.json'),
      JSON.stringify({
        runId: 'future',
        checkedAt: new Date(now + 1).toISOString(),
      }),
    )
    await writeFile(join(idDir, 'broken.json'), '{')
    await recordBaselineInIndex({
      stateRoot,
      runId: 'latest',
      record: record({ checkedAt: at(0) }),
      now,
    })
    const kept = (await entriesOf(stateRoot)).map(([runId]) => runId)
    assert.equal(kept.length, BASELINE_INDEX_KEEP)
    assert.equal(kept[0], 'future')
    assert.equal(kept[1], 'latest')
    assert.ok(!existsSync(join(idDir, 'broken.json')))
    // The oldest went first; the future entry's extra slot pushes the
    // cutoff one entry higher than before.
    for (let i = 0; i < 7; i++)
      assert.ok(!kept.includes(`run-${i}`), `run-${i}`)
    assert.ok(kept.includes('run-7'))
  })

  it('keeps an entry a concurrent writer publishes after the pruner samples its clock', async () => {
    // Writer A reads `now` before listing the directory. If writer B's
    // entry, dated after A's `now`, is already on disk by the time A reads
    // the directory, A's prune must not delete it: it is not stale, just
    // published after A's clock was sampled.
    const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-index-race-'))
    for (let i = 0; i < BASELINE_INDEX_KEEP; i++)
      await recordBaselineInIndex({
        stateRoot,
        runId: `run-${i}`,
        record: record({ checkedAt: at((BASELINE_INDEX_KEEP - i) * 1000) }),
        now,
      })
    const [dir] = await readdir(join(stateRoot, 'baseline-index'))
    assert.ok(dir)
    const idDir = join(stateRoot, 'baseline-index', dir)
    // Writer B publishes its entry, checked after A's sampled `now`.
    await writeFile(
      join(idDir, 'concurrent.json'),
      JSON.stringify({
        runId: 'concurrent',
        checkedAt: new Date(now + 5000).toISOString(),
      }),
    )
    // Writer A's own write and prune, using its earlier-sampled `now`.
    await recordBaselineInIndex({
      stateRoot,
      runId: 'writer-a',
      record: record({ checkedAt: at(0) }),
      now,
    })
    const kept = (await entriesOf(stateRoot)).map(([runId]) => runId)
    assert.ok(kept.includes('concurrent'))
  })

  describe('looking a result up in the index', () => {
    const realAt = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    /** A store holding the given runs' baseline steps, counting reads. */
    const storeOf = (steps: Record<string, unknown>) => {
      const reads: string[] = []
      const store: BaselineStore = {
        getCompletedStep: async (runId) => {
          reads.push(runId)
          return runId in steps
            ? { output: steps[runId], completedAt: realAt(0) }
            : null
        },
        getStepAttempts: async () => [],
      }
      return { store, reads }
    }
    const lookup = async (
      stateRoot: string,
      store: BaselineStore,
      maxAgeMs = 600_000,
    ) =>
      (
        await reusedBaseline({
          stateRoot,
          runId: 'current',
          setup: {
            baselineIdentity: identity,
            checkpointsDir: join(stateRoot, 'checkpoints'),
          } as unknown as FactorySetup,
          reuse: { maxAgeMs },
          store,
          operationKey: 'current/baseline',
        })
      )?.reusedFrom?.runId ?? null
    const index = async (stateRoot: string, runId: string, checkedAt: string) =>
      recordBaselineInIndex({
        stateRoot,
        runId,
        record: record({ checkedAt }),
        now: Date.now() + 3_600_000,
      })
    const step = (checkedAt: string) => ({ ...measured(), checkedAt })

    it('skips an entry dated in the future and reuses a valid older one', async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-lookup-'))
      const future = new Date(Date.now() + 600_000).toISOString()
      const older = realAt(60_000)
      await index(stateRoot, 'future', future)
      await index(stateRoot, 'older', older)
      const { store, reads } = storeOf({
        future: step(future),
        older: step(older),
      })
      assert.equal(await lookup(stateRoot, store), 'older')
      assert.deepEqual(reads, ['older'])
    })

    it('takes the newest valid entry, whichever was written last', async () => {
      for (const order of [
        ['newer', 'older'],
        ['older', 'newer'],
      ]) {
        const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-lookup-'))
        const times: Record<string, string> = {
          newer: realAt(10_000),
          older: realAt(20_000),
        }
        for (const runId of order)
          await index(stateRoot, runId, times[runId] ?? '')
        const { store } = storeOf({
          newer: step(times['newer'] ?? ''),
          older: step(times['older'] ?? ''),
        })
        assert.equal(await lookup(stateRoot, store), 'newer', order.join())
      }
    })

    it('falls back to the next entry when the newest no longer validates, and measures when none does', async () => {
      const stateRoot = await mkdtemp(join(tmpdir(), 'baseline-lookup-'))
      const newest = realAt(5_000)
      const next = realAt(10_000)
      const expired = realAt(700_000)
      await index(stateRoot, 'newest', newest)
      await index(stateRoot, 'next', next)
      await index(stateRoot, 'expired', expired)
      // The newest run's step failed on replay; the next one holds.
      const fallback = storeOf({
        newest: { ...step(newest), passed: false },
        next: step(next),
        expired: step(expired),
      })
      assert.equal(await lookup(stateRoot, fallback.store), 'next')
      assert.deepEqual(fallback.reads, ['newest', 'next'])
      // No valid step left: the expired entry is never even read.
      const none = storeOf({ newest: { ...step(newest), passed: false } })
      assert.equal(await lookup(stateRoot, none.store), null)
      assert.deepEqual(none.reads, ['newest', 'next'])
    })
  })
})

describe('the check executable a baseline identity names', () => {
  it('finds it in the worktree for an empty PATH entry, as spawn does', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-executable-'))
    const workdir = join(root, 'work')
    const bin = join(root, 'bin')
    await mkdir(workdir, { recursive: true })
    await mkdir(bin, { recursive: true })
    for (const dir of [workdir, bin])
      await writeFile(join(dir, 'mycheck'), '#!/bin/sh\nexit 0\n', {
        mode: 0o755,
      })
    const identityWith = async (path: string) => {
      const saved = process.env.PATH
      process.env.PATH = path
      try {
        return await baselineIdentityOf({
          repoPath: root,
          workdir,
          baseCommit: 'a'.repeat(40),
          checkCommand: ['mycheck'],
          setupCommand: null,
          checkTimeoutMs: 1000,
        } as unknown as Parameters<typeof baselineIdentityOf>[0])
      } finally {
        process.env.PATH = saved
      }
    }
    // Leading, middle and trailing empty entries all mean the worktree.
    for (const path of [
      `${delimiter}${bin}`,
      `/nonexistent${delimiter}${delimiter}${bin}`,
    ])
      assert.equal(
        (await identityWith(path))?.checkExecutable,
        './mycheck',
        path,
      )
    assert.equal(
      (await identityWith(`${bin}${delimiter}`))?.checkExecutable,
      await realpath(join(bin, 'mycheck')),
    )
    assert.equal(
      (await identityWith(`/nonexistent${delimiter}`))?.checkExecutable,
      './mycheck',
    )
    // The actual spawn agrees: an empty entry first runs the worktree's file.
    const saved = process.env.PATH
    process.env.PATH = `${delimiter}${bin}`
    try {
      await writeFile(join(workdir, 'mycheck'), '#!/bin/sh\necho worktree\n', {
        mode: 0o755,
      })
      await writeFile(join(bin, 'mycheck'), '#!/bin/sh\necho bin\n', {
        mode: 0o755,
      })
      const res = await runChild('mycheck', [], {
        cwd: workdir,
        timeoutMs: 10000,
      })
      assert.equal(res.stdout.trim(), 'worktree')
    } finally {
      process.env.PATH = saved
    }
  })
})

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

describe('repair across an effort change', { timeout: 300000 }, () => {
  const fake = (
    requestedModel: string | null = null,
    requestedEffort: string | null = null,
  ) => ({ provider: 'fake' as const, requestedModel, requestedEffort })

  it('continues the implementation session at the repair effort only when setup allows it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-effort-'))
    delete process.env.FAKE_FAIL_FIRST
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: dir })
    await durably.migrate()
    const trigger = (args: {
      code?: ReturnType<typeof fake>
      repair: ReturnType<typeof fake> | null
      context?: 'reuse' | 'fresh'
    }) =>
      durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: args.code ?? fake(),
          correctness: fake(),
          'edge-cases': fake(),
          ...(args.repair ? { repair: args.repair } : {}),
        },
        target: { kind: 'subject' as const },
        maxIterations: 2,
        context: args.context ?? 'reuse',
        // The first implementation leaves the bug, so one repair follows.
        fakeScenario: { failIterations: 1, claudeEffortResume: true },
      })
    const ids: Record<string, string> = {}
    try {
      ids['effort'] = (await trigger({ repair: fake(null, 'high') })).id
      ids['fresh'] = (
        await trigger({ repair: fake(null, 'high'), context: 'fresh' })
      ).id
      ids['model'] = (
        await trigger({ repair: fake('repair-model', 'high') })
      ).id
      ids['same'] = (await trigger({ repair: null })).id
      // Two spellings of one model: the fake "CLI" runs `fake` as
      // `fake-model`, and preflight reads that back.
      ids['alias'] = (
        await trigger({
          code: fake('fake'),
          repair: fake('fake-model', 'high'),
        })
      ).id
      // A model the fake "CLI" never reports: preflight cannot confirm it.
      ids['unobserved'] = (
        await trigger({
          code: fake('unobserved-model'),
          repair: fake('unobserved-model', 'high'),
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
      const calls = async (name: string) => {
        const report = await buildReport(durably, ids[name] ?? '')
        assert.equal(report.status, 'waiting', name)
        const [implement, repair] = report.attempts
          .filter((a) => a.stepName.endsWith(':code:agent'))
          .map((a) => a.measurement)
        assert.equal(implement?.role, 'implement', name)
        assert.equal(repair?.role, 'repair', name)
        return { report, implement, repair }
      }

      // Same model, another effort: the repair resumes the implementation
      // session, at its own effort, and reads the cache back.
      const effort = await calls('effort')
      assert.equal(effort.repair?.sessionId, effort.implement?.sessionId)
      assert.equal(effort.implement?.effectiveEffort, 'low')
      assert.equal(effort.repair?.effectiveEffort, 'high')
      assert.equal(effort.repair?.reportedEffort, 'high')
      assert.equal(effort.repair?.sessionHandling, 'continued-effort-change')
      /**
       * A run's setup, its recorded repair session decision, and the two
       * versions its settings can take: without the policy, as before it
       * existed, and with it.
       */
      const versionsOf = async (name: string) => {
        const id = ids[name] ?? ''
        const setup = (await durably.storage.getCompletedStep(id, 'setup'))
          ?.output as FactorySetup
        const record = (
          await durably.storage.getCompletedStep(id, REPAIR_SESSION_STEP)
        )?.output as RepairSessionRecord
        const versionOf = (repairSession: string | null) =>
          configVersionOf({
            contextMode: setup.contextMode,
            instructionsVersion: setup.instructionsVersion,
            maxIterations: setup.maxIterations,
            target: 'subject',
            agentTimeoutMs: setup.agentTimeoutMs,
            checkTimeoutMs: resolveTimeouts('subject', null).checkTimeoutMs,
            code: setup.profiles.code,
            repair: setup.repair ?? null,
            repairSession,
            correctness: setup.profiles.correctness,
            edgeCases: setup.profiles['edge-cases'],
            triage: null,
            cli: {},
            commit: null,
            review: {},
          })
        return {
          setup,
          record,
          prePolicy: versionOf(null),
          withPolicy: versionOf(EFFORT_RESUME_POLICY),
        }
      }
      const effortVersions = await versionsOf('effort')
      // Setup finds it eligible and keeps the version without the policy;
      // preflight confirms it, and the run takes the version with it.
      assert.equal(effortVersions.setup.repairSession?.eligible, true)
      assert.equal(effortVersions.setup.configVersion, effortVersions.prePolicy)
      assert.equal(effortVersions.record.confirmed.continues, true)
      assert.equal(
        effortVersions.record.configVersion,
        effortVersions.withPolicy,
      )
      assert.equal(effort.report.configVersion, effortVersions.withPolicy)
      assert.equal(effort.repair?.configVersion, effortVersions.withPolicy)

      // The same settings in fresh context start a new session, and read
      // less from cache than the resumed repair did.
      const fresh = await calls('fresh')
      assert.notEqual(fresh.repair?.sessionId, fresh.implement?.sessionId)
      assert.equal(fresh.repair?.sessionHandling, 'fresh')
      assert.ok(
        (effort.repair?.usage?.cacheReadTokens ?? 0) >
          (fresh.repair?.usage?.cacheReadTokens ?? 0),
      )

      // Another model starts a new session whatever the effort: setup
      // cannot tell, preflight sees two models.
      const model = await calls('model')
      assert.notEqual(model.repair?.sessionId, model.implement?.sessionId)
      assert.equal(model.repair?.sessionHandling, 'fresh')

      // A repair on the code profile continues as it always did.
      const same = await calls('same')
      assert.equal(same.repair?.sessionId, same.implement?.sessionId)
      assert.equal(same.repair?.sessionHandling, 'continued')

      // Each repair call, with its handling and its own cache-read ratio,
      // in the JSON and the Markdown report.
      const [resumed] = effort.report.repairCalls
      assert.equal(effort.report.repairCalls.length, 1)
      assert.equal(resumed?.sessionHandling, 'continued-effort-change')
      assert.equal(resumed?.cacheReadRatio, 43628 / 46000)
      const [started] = fresh.report.repairCalls
      assert.equal(started?.sessionHandling, 'fresh')
      assert.equal(started?.cacheReadRatio, 0)
      const json = JSON.parse(reportToJson(effort.report)) as {
        repairCalls: { sessionHandling: string; cacheReadRatio: number }[]
      }
      assert.equal(
        json.repairCalls[0]?.sessionHandling,
        'continued-effort-change',
      )
      assert.equal(json.repairCalls[0]?.cacheReadRatio, 43628 / 46000)
      const md = reportToMarkdown(effort.report)
      assert.match(
        md,
        /## Repair calls[\s\S]*\| continued-effort-change \| 46000 \| 43628 \| 0\.9484 \|/,
      )
      assert.match(reportToMarkdown(same.report), /\| continued \|/)

      // Setup found the other model eligible, as it cannot tell an alias
      // from a model; preflight saw two models, so the run keeps the
      // version it had before the policy existed, and says why.
      const modelVersions = await versionsOf('model')
      assert.equal(modelVersions.setup.repairSession?.eligible, true)
      assert.equal(modelVersions.record.confirmed.continues, false)
      assert.equal(model.report.configVersion, modelVersions.prePolicy)
      assert.notEqual(model.report.configVersion, modelVersions.withPolicy)
      assert.equal(model.repair?.configVersion, modelVersions.prePolicy)
      assert.match(
        model.report.repairSession?.confirmed.reason ?? '',
        /code runs on fake-model and repair on repair-model/,
      )
      assert.match(
        model.report.repairCalls[0]?.sessionReason ?? '',
        /code runs on fake-model and repair on repair-model/,
      )
      const modelJson = JSON.parse(reportToJson(model.report)) as {
        repairSession: {
          setup: { eligible: boolean }
          confirmed: { continues: boolean; reason: string }
        }
      }
      assert.equal(modelJson.repairSession.setup.eligible, true)
      assert.equal(modelJson.repairSession.confirmed.continues, false)
      assert.match(
        reportToMarkdown(model.report),
        /- repair session: starts new \(code runs on fake-model/,
      )

      // The effective models are spelled differently, as `opus` and
      // `claude-opus-5-5` are; preflight saw both run as `fake-model`: the
      // repair resumes the implementation session at its own effort, and
      // the run's config version carries the policy.
      const alias = await calls('alias')
      assert.equal(alias.implement?.requestedModel, 'fake')
      assert.equal(alias.repair?.requestedModel, 'fake-model')
      assert.equal(alias.implement?.effectiveModel, 'fake')
      assert.equal(alias.repair?.effectiveModel, 'fake-model')
      assert.equal(alias.repair?.sessionId, alias.implement?.sessionId)
      assert.equal(alias.repair?.effectiveEffort, 'high')
      assert.equal(alias.repair?.sessionHandling, 'continued-effort-change')
      const aliasVersions = await versionsOf('alias')
      assert.equal(aliasVersions.record.confirmed.continues, true)
      assert.equal(alias.report.configVersion, aliasVersions.withPolicy)
      assert.notEqual(alias.report.configVersion, aliasVersions.prePolicy)
      assert.match(
        reportToMarkdown(alias.report),
        /- repair session: continues across effort on fake-model/,
      )
      // Preflight made a minimal call per setting, as it does for Claude.
      assert.ok(alias.report.preflight?.checks.every((c) => c.called))

      // A model preflight saw nothing for: a new session, as before.
      const unobserved = await calls('unobserved')
      assert.notEqual(
        unobserved.repair?.sessionId,
        unobserved.implement?.sessionId,
      )
      assert.equal(unobserved.repair?.sessionHandling, 'fresh')
      // Eligible at setup, never confirmed: the pre-policy version.
      const unobservedVersions = await versionsOf('unobserved')
      assert.equal(unobservedVersions.setup.repairSession?.eligible, true)
      assert.equal(
        unobserved.report.configVersion,
        unobservedVersions.prePolicy,
      )
      assert.match(
        unobserved.report.repairSession?.confirmed.reason ?? '',
        /did not report/,
      )
      assert.match(
        reportToMarkdown(unobserved.report),
        /## Repair calls[\s\S]*\| fresh \|/,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  describe('the code stage itself', () => {
    const profile = (
      id: string,
      effort: string,
      model: string | null = null,
    ): ResolvedProfile => ({
      id,
      provider: 'fake',
      requestedModel: model,
      requestedEffort: effort,
      effectiveModel: 'fake-model',
      effectiveEffort: effort,
    })
    const code = profile('fake:fake-model:low:code', 'low')
    const repair = profile('fake:fake-model:high:repair', 'high')

    /** Run one repair code stage with a stub provider, and what it was sent. */
    async function repairOnce(patch: {
      setup?: Partial<FactorySetup>
      state?: Partial<FactoryState>
      session?: Partial<SessionRef> | null
    }) {
      const root = await mkdtemp(join(tmpdir(), 'code-stage-'))
      const setup = {
        fake: true,
        contextMode: 'reuse',
        target: { kind: 'subject' },
        checkpointsDir: join(root, 'checkpoints'),
        instructionsVersion: 'v',
        configVersion: 'cv',
        profiles: { code, correctness: code, 'edge-cases': code },
        repair,
        maxIterations: 2,
        agentTimeoutMs: 60000,
        autoApprove: false,
        ...patch.setup,
      } as FactorySetup
      const session: SessionRef | null =
        patch.session === null
          ? null
          : {
              provider: 'fake',
              nativeId: 'implementation-session',
              profileId: code.id,
              model: 'fake-model',
              cwd: root,
              instructionsVersion: 'v',
              ...patch.session,
            }
      const state: FactoryState = {
        ...initialState(setup, {
          continues: true,
          reason: 'test',
          model: 'fake-model',
        }),
        iteration: 1,
        implementationSession: session,
        repairNotes: ['acceptance: failed'],
        ...patch.state,
      }
      const sent: AgentCallOptions[] = []
      const provider: AgentProvider = {
        name: 'fake',
        fake: true,
        cliPath: null,
        partialUsage: false,
        resolveExecution: (r) => ({
          model: r.requestedModel ?? 'fake-model',
          effort: r.requestedEffort,
        }),
        call: async (options) => {
          sent.push(options)
          return {
            text: 'fixed',
            session: { id: options.sessionId ?? 'new-session' },
            // As Claude Code: the requested name runs as written.
            resolvedModel: options.requestedModel ?? 'fake-model',
            resolvedEffort: options.requestedEffort,
            reportedModel: null,
            reportedEffort: null,
            // As Claude Code, which runs the alias `fake` as `fake-model`.
            observedModel:
              (options.requestedModel ?? 'fake-model') === 'fake'
                ? 'fake-model'
                : (options.requestedModel ?? 'fake-model'),
            usage: null,
            elapsedMs: 1,
          }
        },
        checkAvailability: async () => ({
          verdict: 'available',
          method: 'stub',
          detail: 'stub',
        }),
        rejectionReason: () => null,
      }
      const measurements: AttemptMeasurement[] = []
      const step = {
        runId: 'run-1',
        run: async (
          _name: string,
          fn: (signal: AbortSignal, attempt: unknown) => Promise<unknown>,
        ) =>
          fn(new AbortController().signal, {
            id: randomId(),
            setMetadata: async (m: unknown) => {
              measurements.push(m as AttemptMeasurement)
            },
          }),
      }
      const target = {
        workdir: root,
        taskBrief: () => 'Fix add().',
        implementationRules: () => [],
        untrustedInputs: () => [],
        seal: async () => ({
          id: 'candidate-2',
          snapshotDir: root,
          sourceHash: 'h',
          acceptanceHash: 'h',
        }),
      }
      const event = await codeStage({
        step: step as never,
        state,
        decision: { stage: 'code', role: 'repair', reason: 'test' },
        key: 'stage:3:code',
        services: {
          providers: {
            code: provider,
            correctness: provider,
            'edge-cases': provider,
            repair: provider,
          },
          target: target as never,
        },
      })
      return { sent: sent[0], measurement: measurements.at(-1), event }
    }
    let counter = 0
    const randomId = () => `attempt-${++counter}`

    it('resumes at the repair effort with a continuing prompt, and records the session it returned', async () => {
      const { sent, measurement, event } = await repairOnce({})
      assert.equal(sent?.sessionId, 'implementation-session')
      assert.equal(sent?.requestedEffort, 'high')
      assert.doesNotMatch(sent?.prompt ?? '', /starting a new session/)
      assert.match(sent?.prompt ?? '', /continuing the repair conversation/)
      assert.equal(measurement?.sessionHandling, 'continued-effort-change')
      assert.ok(event.type === 'code.completed')
      if (event.type !== 'code.completed') return
      assert.equal(event.session?.nativeId, 'implementation-session')
      assert.equal(event.session?.profileId, repair.id)
      assert.equal(event.session?.model, 'fake-model')
    })

    it('starts new, and says so, when setup did not allow it or the session predates the model', async () => {
      for (const [name, patch] of [
        ['not allowed', { state: { repairSession: null } }],
        [
          'refused at preflight',
          {
            state: {
              repairSession: {
                continues: false,
                reason: 'preflight did not report the model',
              },
            },
          },
        ],
        ['no model on record', { session: { model: undefined } }],
        ['a null model on record', { session: { model: null } }],
      ] as const) {
        const { sent, measurement } = await repairOnce(patch)
        assert.equal(sent?.sessionId, null, name)
        assert.match(sent?.prompt ?? '', /starting a new session/, name)
        assert.equal(measurement?.sessionHandling, 'fresh', name)
      }
    })

    it('starts new, and says why, on a session that ran another model than the confirmed one', async () => {
      const { sent, measurement } = await repairOnce({
        session: { model: 'another-model' },
      })
      assert.equal(sent?.sessionId, null)
      assert.match(sent?.prompt ?? '', /starting a new session/)
      assert.equal(measurement?.sessionHandling, 'fresh')
      assert.match(
        measurement?.sessionReason ?? '',
        /ran on another-model, not the confirmed fake-model/,
      )
    })

    it('compares the model preflight confirmed, not the profile spelling', async () => {
      // The repair profile names an alias; preflight confirmed both profiles
      // run `fake-model`. The session recorded under that model resumes, and
      // the session the repair returns records it too.
      const aliased: ResolvedProfile = {
        ...profile(repair.id, 'high', 'fake'),
        effectiveModel: 'fake',
      }
      const { sent, measurement, event } = await repairOnce({
        setup: { repair: aliased },
      })
      assert.equal(sent?.sessionId, 'implementation-session')
      assert.equal(measurement?.sessionHandling, 'continued-effort-change')
      assert.ok(event.type === 'code.completed')
      if (event.type !== 'code.completed') return
      // The model the call reported running, not the profile's alias.
      assert.equal(event.session?.model, 'fake-model')
      // A session recorded under the alias spelling is not the confirmed
      // model: a new session.
      const spelled = await repairOnce({
        setup: { repair: aliased },
        session: { model: 'fake' },
      })
      assert.equal(spelled.sent?.sessionId, null)
      assert.equal(spelled.measurement?.sessionHandling, 'fresh')
    })

    it("never resumes the parent's session in a repair run's first repair", async () => {
      const { sent, measurement } = await repairOnce({
        setup: {
          repairOf: { runId: 'parent', candidateCommit: 'a'.repeat(40) },
        },
        state: { iteration: 0 },
      })
      assert.equal(sent?.sessionId, null)
      assert.equal(measurement?.sessionHandling, 'fresh')
      assert.match(sent?.prompt ?? '', /FINDINGS block/)
    })
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
      '- [ ]',
      '* * *',
      '- - -',
      '___',
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
    // subheading's item, and the Japanese section's item. The empty checkbox
    // and the thematic breaks are not items.
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
