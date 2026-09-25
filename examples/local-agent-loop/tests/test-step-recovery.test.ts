import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runChild } from '../src/engine/child.js'
import { resolveCommit } from '../src/engine/git.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { runVerificationStep } from '../src/engine/verification.js'
import { RepoTarget } from '../src/targets/repo.js'
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

/** A one-commit repository and a repo target whose check is `script`. */
async function repoWithCheck(script: string, checkTimeoutMs = 60000) {
  const root = await mkdtemp(join(tmpdir(), 'verify-logs-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = async (args: string[]) => {
    const res = await runChild('git', args, { cwd: repo, timeoutMs: 30000 })
    if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  }
  await git(['init', '--initial-branch=main'])
  await git(['config', 'user.email', 'test@localhost'])
  await git(['config', 'user.name', 'test'])
  await writeFile(join(repo, 'check.cjs'), script)
  await git(['add', '-A'])
  await git(['commit', '-m', 'base'])
  const baseCommit = await resolveCommit(repo, 'HEAD')
  const target = new RepoTarget({
    kind: 'repo',
    repoPath: repo,
    baseCommit,
    branch: 'main',
    workdir: repo,
    setupCommand: null,
    checkCommand: [process.execPath, 'check.cjs'],
    checkTimeoutMs,
    task: 'task',
    spec: null,
    dispositions: null,
    issue: null,
    deliveryDir: join(root, 'delivery'),
    candidatesDir: join(root, 'candidates'),
    publish: false,
  })
  const candidate = await target.seal({
    iteration: 1,
    attemptId: 'seal',
    signal: new AbortController().signal,
  })
  // One verification step, graded the way the verify stage grades it: a
  // log directory per physical attempt.
  const specFor = (attemptId: string) => ({
    provider: 'fake' as const,
    operationKey: 'run/stage:1:verify/acceptance',
    checkpointsDir: join(root, 'checkpoints'),
    stage: 'verify',
    iteration: 1,
    grade: (signal: AbortSignal) =>
      target.grade({
        candidate,
        scratchDir: join(root, 'scratch', attemptId),
        logDir: logDirFor(attemptId),
        signal,
      }),
  })
  const logDirFor = (attemptId: string) =>
    join(root, 'verification-logs', candidate.id, attemptId)
  return { root, specFor, logDirFor }
}

describe('verification logs', () => {
  it('keeps the whole check output of each attempt, past every cap', async () => {
    // The failure sits in the middle of about 3 MB of output: well past the
    // subprocess, target and checkpoint excerpts, which keep only the tail.
    const { specFor } = await repoWithCheck(`
      const line = 'x'.repeat(100) + '\\n'
      let out = ''
      for (let i = 0; i < 30000; i++) {
        out += i === 15000 ? 'MIDDLE-FAILURE: expected 3, got 2\\n' : line
      }
      process.stdout.write(out)
      process.stderr.write('STDERR-MARKER\\n')
      process.exitCode = 1
    `)
    const first = attempt()
    const graded = await runVerificationStep(
      first as never,
      specFor(first.id),
      new AbortController().signal,
    )
    assert.equal(graded.passed, false)
    assert.equal(graded.exitCode, 1)
    assert.doesNotMatch(graded.stdout, /MIDDLE-FAILURE/)
    const log = graded.log
    assert.ok(log)
    assert.equal(log.exitCode, 1)
    const stdout = await readFile(log.stdoutPath, 'utf8')
    assert.match(stdout, /MIDDLE-FAILURE: expected 3, got 2/)
    assert.equal(stdout.length, 30000 * 101 - 101 + 34)
    assert.equal(await readFile(log.stderrPath, 'utf8'), 'STDERR-MARKER\n')
    assert.ok(log.stdoutPath.includes(first.id))
    assert.deepEqual(first.snapshots.at(-1)?.verificationLog, log)
    // The excerpt the repair prompt and the report use is unchanged.
    assert.ok(first.snapshots.at(-1)?.error?.endsWith('STDERR-MARKER\n'))

    // A completed checkpoint is read back: no second grading, and the same
    // log and exit code.
    const replay = attempt()
    const replayed = await runVerificationStep(
      replay as never,
      specFor(replay.id),
      new AbortController().signal,
    )
    assert.deepEqual(replayed, graded)
    assert.deepEqual(replay.snapshots.at(-1)?.verificationLog, log)
    assert.equal(replay.snapshots.at(-1)?.result, 'checkpoint-recovered')
    assert.equal(
      existsSync(dirname(log.stdoutPath.replace(first.id, replay.id))),
      false,
    )
  })

  it('records a null exit code on a timeout and keeps what was printed', async () => {
    const { specFor } = await repoWithCheck(
      `process.stdout.write('BEFORE-KILL\\n'); setInterval(() => {}, 1000)`,
      300,
    )
    const a = attempt()
    const graded = await runVerificationStep(
      a as never,
      specFor(a.id),
      new AbortController().signal,
    )
    assert.equal(graded.passed, false)
    assert.equal(graded.exitCode, null)
    assert.equal(graded.log?.exitCode, null)
    assert.equal(
      await readFile(graded.log?.stdoutPath ?? '', 'utf8'),
      'BEFORE-KILL\n',
    )
    assert.equal(a.snapshots.at(-1)?.verificationLog?.exitCode, null)
  })

  it('re-grades a start-only checkpoint into a new log, keeping the old one', async () => {
    // The check hangs until a gate file beside the repository exists.
    const { root, specFor, logDirFor } = await repoWithCheck(`
      process.stdout.write('STARTED\\n')
      if (require('node:fs').existsSync('../gate')) process.stdout.write('DONE\\n')
      else setInterval(() => {}, 1000)
    `)
    // The first attempt is cut off mid-grading, as a lost lease would, once
    // the check has printed its first line.
    const lost = attempt()
    const controller = new AbortController()
    const lostLog = join(logDirFor(lost.id), 'stdout.log')
    const grading = runVerificationStep(
      lost as never,
      specFor(lost.id),
      controller.signal,
    )
    const deadline = Date.now() + 30000
    while (
      !(existsSync(lostLog) && (await readFile(lostLog, 'utf8')).length > 0)
    ) {
      if (Date.now() > deadline) throw new Error('check never started')
      // sleep-ok(poll): one tick of a loop that re-checks the log until it has output
      await new Promise((r) => setTimeout(r, 20))
    }
    controller.abort()
    await assert.rejects(grading, /cancelled/)
    // The interrupted attempt's measurement points at its partial log.
    const lostMeasurement = lost.snapshots.at(-1)
    assert.equal(lostMeasurement?.interruptionReason, 'cancelled-or-lease-lost')
    assert.equal(lostMeasurement?.verificationLog?.stdoutPath, lostLog)
    assert.equal(lostMeasurement?.verificationLog?.exitCode, null)
    await writeFile(join(root, 'gate'), '')
    const retry = attempt()
    const graded = await runVerificationStep(
      retry as never,
      specFor(retry.id),
      new AbortController().signal,
    )
    assert.equal(graded.exitCode, 0)
    assert.ok(graded.log?.stdoutPath.includes(retry.id))
    assert.equal(
      await readFile(graded.log?.stdoutPath ?? '', 'utf8'),
      'STARTED\nDONE\n',
    )
    // The cut-off attempt's partial log is still where it was written.
    assert.equal(await readFile(lostLog, 'utf8'), 'STARTED\n')
  })
})
