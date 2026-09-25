import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runChild } from '../src/engine/child.js'
import { DETAIL_PREFIX } from '../src/engine/failure-details.js'
import { classifyFailure } from '../src/engine/failure-reasons.js'
import { resolveCommit } from '../src/engine/git.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { runVerificationStep } from '../src/engine/verification.js'
import { assertSetupLeftNoUntracked, RepoTarget } from '../src/targets/repo.js'
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

  it('records no log for an attempt cancelled before the check started', async () => {
    const { specFor, logDirFor } = await repoWithCheck(`process.exitCode = 0`)
    const a = attempt()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runVerificationStep(a as never, specFor(a.id), controller.signal),
      /before spawn/,
    )
    assert.equal(a.snapshots.at(-1)?.verificationLog, null)
    assert.equal(existsSync(join(logDirFor(a.id), 'stdout.log')), false)
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
    assert.equal(lostMeasurement?.verificationLog?.interrupted, true)
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

/** A one-commit repository and a repo target at its base, graded by `script`. */
async function baseRepo(
  script: string,
  checkTimeoutMs = 60000,
  checkCommand = [process.execPath, 'check.cjs'],
) {
  const root = await mkdtemp(join(tmpdir(), 'baseline-'))
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
  const target = new RepoTarget({
    kind: 'repo',
    repoPath: repo,
    baseCommit: await resolveCommit(repo, 'HEAD'),
    branch: 'main',
    workdir: repo,
    setupCommand: null,
    checkCommand,
    checkTimeoutMs,
    task: 'task',
    spec: null,
    dispositions: null,
    issue: null,
    deliveryDir: join(root, 'delivery'),
    candidatesDir: join(root, 'candidates'),
    publish: false,
  })
  const logDirFor = (attemptId: string) =>
    join(root, 'baseline-logs', attemptId)
  // The baseline step as the job runs it: the verification checkpoint pair
  // around `gradeBase`, a log directory per physical attempt.
  const specFor = (attemptId: string) => ({
    provider: 'fake' as const,
    operationKey: 'run/baseline',
    checkpointsDir: join(root, 'checkpoints'),
    stage: 'baseline',
    iteration: 0,
    grade: (signal: AbortSignal) =>
      target.gradeBase({ logDir: logDirFor(attemptId), signal }),
  })
  return { root, repo, specFor, logDirFor }
}

describe('baseline check on the base commit', () => {
  it('records the failing exit code and the full log, and reads the verdict back on resume', async () => {
    const { specFor, logDirFor } = await baseRepo(`
      process.stdout.write('BASE-OUT\\n')
      process.stderr.write('BASE-ERR\\n')
      process.exitCode = 3
    `)
    const first = attempt()
    const graded = await runVerificationStep(
      first as never,
      specFor(first.id),
      new AbortController().signal,
    )
    assert.equal(graded.passed, false)
    assert.equal(graded.exitCode, 3)
    assert.equal(graded.log?.exitCode, 3)
    assert.equal(
      await readFile(graded.log?.stdoutPath ?? '', 'utf8'),
      'BASE-OUT\n',
    )
    assert.equal(
      await readFile(graded.log?.stderrPath ?? '', 'utf8'),
      'BASE-ERR\n',
    )
    assert.equal(first.snapshots.at(-1)?.stage, 'baseline')
    // A resumed worker reads the completed verdict: no second check.
    const replay = attempt()
    const replayed = await runVerificationStep(
      replay as never,
      specFor(replay.id),
      new AbortController().signal,
    )
    assert.deepEqual(replayed, graded)
    assert.equal(replay.snapshots.at(-1)?.result, 'checkpoint-recovered')
    assert.equal(existsSync(logDirFor(replay.id)), false)
  })

  it('records a timeout with no exit code, and how long the check ran', async () => {
    const { specFor } = await baseRepo(
      `process.stdout.write('HUNG\\n'); setInterval(() => {}, 1000)`,
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
    assert.ok((graded.log?.timedOutAfterMs ?? 0) >= 300)
    assert.equal(await readFile(graded.log?.stdoutPath ?? '', 'utf8'), 'HUNG\n')
  })

  it('refuses a worktree that is no longer the clean base commit', async () => {
    const { repo, specFor } = await baseRepo(`process.exitCode = 0`)
    await writeFile(join(repo, 'check.cjs'), 'process.exitCode = 1\n')
    const a = attempt()
    await assert.rejects(
      runVerificationStep(
        a as never,
        specFor(a.id),
        new AbortController().signal,
      ),
      /baseline-check-failed: baseline-mutated: setup left uncommitted changes/,
    )
  })

  it('removes what a passing check leaves untracked, also after a resume, and keeps ignored files', async () => {
    const { repo, specFor } = await baseRepo(`
      const { mkdirSync, writeFileSync } = require('node:fs')
      mkdirSync('coverage', { recursive: true })
      writeFileSync('coverage/lcov.info', 'x')
      writeFileSync('junit.xml', 'x')
      writeFileSync('cache.log', 'x')
      // A nested repository with a commit, which plain \`git clean -fd\` skips.
      const { execFileSync } = require('node:child_process')
      mkdirSync('fixture-repo')
      execFileSync('git', ['init', '-q'], { cwd: 'fixture-repo' })
      writeFileSync('fixture-repo/a.txt', 'x')
      execFileSync('git', ['add', '.'], { cwd: 'fixture-repo' })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: 'fixture-repo' })
    `)
    await writeFile(
      join(repo, '.git', 'info', 'exclude'),
      '*.log\nnode_modules/\n',
    )
    // Ignored setup output, such as installed dependencies, stays.
    await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), 'x')
    // What an interrupted first attempt of the check left behind: on resume
    // it is graded again, and its output must not survive either.
    await mkdir(join(repo, 'test-results'))
    await writeFile(join(repo, 'test-results', 'partial.xml'), 'x')
    const a = attempt()
    const graded = await runVerificationStep(
      a as never,
      specFor(a.id),
      new AbortController().signal,
    )
    assert.equal(graded.passed, true)
    // Nothing the check wrote reaches `git add -A` at the first sealing.
    assert.equal(existsSync(join(repo, 'coverage', 'lcov.info')), false)
    assert.equal(existsSync(join(repo, 'junit.xml')), false)
    assert.equal(existsSync(join(repo, 'test-results')), false)
    assert.equal(existsSync(join(repo, 'fixture-repo')), false)
    assert.equal(existsSync(join(repo, 'cache.log')), true)
    assert.equal(
      existsSync(join(repo, 'node_modules', 'dep', 'index.js')),
      true,
    )
  })

  it('stops as a baseline failure when the cleanup cannot remove the check output', async () => {
    // The check itself leaves output in a directory the clean cannot write
    // to: git either fails or leaves it behind, and both must stop as a
    // baseline failure rather than an unclassified one.
    const { repo, specFor } = await baseRepo(`
      const { chmodSync, mkdirSync, writeFileSync } = require('node:fs')
      mkdirSync('locked')
      writeFileSync('locked/keep.txt', 'x')
      chmodSync('locked', 0o500)
    `)
    const { chmod } = await import('node:fs/promises')
    try {
      const a = attempt()
      await assert.rejects(
        runVerificationStep(
          a as never,
          specFor(a.id),
          new AbortController().signal,
        ),
        (err: Error) => {
          assert.match(
            err.message,
            /^baseline-check-failed: baseline-mutated: /,
          )
          return true
        },
      )
    } finally {
      await chmod(join(repo, 'locked'), 0o700).catch(() => {})
    }
  })

  it('finds leftover setup output under a translated git locale', async () => {
    const { repo } = await baseRepo(`process.exitCode = 0`)
    await writeFile(join(repo, 'setup.lock'), 'x')
    const saved = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE }
    process.env.LC_ALL = 'fr_FR.UTF-8'
    process.env.LANGUAGE = 'fr'
    try {
      await assert.rejects(
        assertSetupLeftNoUntracked(repo),
        /setup-untracked: /,
      )
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
  })

  it('stops before the check when setup leaves files .gitignore does not cover', async () => {
    const { repo } = await baseRepo(`process.exitCode = 0`)
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'node_modules/\n')
    await mkdir(join(repo, 'node_modules'))
    await writeFile(join(repo, 'node_modules', 'dep.js'), 'x')
    // Ignored output only: setup may leave it, also in a new directory that
    // holds nothing else, because the clean after the check keeps it too.
    await writeFile(
      join(repo, '.git', 'info', 'exclude'),
      'node_modules/\n*.log\n',
    )
    await mkdir(join(repo, 'logs'))
    await writeFile(join(repo, 'logs', 'setup.log'), 'x')
    await assertSetupLeftNoUntracked(repo)
    // Not even an empty directory: the clean after a passing check would
    // remove it before any agent sees it.
    await mkdir(join(repo, 'tmp'))
    await assert.rejects(assertSetupLeftNoUntracked(repo), /setup-untracked: /)
    await rmdir(join(repo, 'tmp'))

    await mkdir(join(repo, 'generated'))
    await writeFile(join(repo, 'generated', 'schema.ts'), 'x')
    await writeFile(join(repo, 'setup.lock'), 'x')
    await assert.rejects(assertSetupLeftNoUntracked(repo), (err: Error) => {
      assert.match(err.message, /^baseline-check-failed: setup-untracked: /)
      const failure = classifyFailure({
        runId: 'r',
        status: 'failed',
        output: null,
        error: err.message,
        uncertain: [],
      })
      assert.equal(failure?.kind, 'baseline-check-failed')
      assert.equal(failure?.setupUntracked, true)
      assert.match(failure?.humanCheck ?? '', /\.gitignore[\s\S]*baselineCheck/)
      assert.deepEqual(
        failure?.details.filter((d) =>
          d.startsWith(DETAIL_PREFIX.setupUntracked),
        ),
        [
          `${DETAIL_PREFIX.setupUntracked}generated/`,
          `${DETAIL_PREFIX.setupUntracked}setup.lock`,
        ],
      )
      return true
    })
  })

  it('stops as a baseline failure when the check changes tracked files or cannot start', async () => {
    const mutating = await baseRepo(
      `require('node:fs').appendFileSync('check.cjs', '// edited\\n')`,
    )
    const a = attempt()
    await assert.rejects(
      runVerificationStep(
        a as never,
        mutating.specFor(a.id),
        new AbortController().signal,
      ),
      /baseline-check-failed: baseline-mutated: the check changed tracked files/,
    )
    const missing = await baseRepo('', 60000, ['no-such-check-command-xyz'])
    const b = attempt()
    await assert.rejects(
      runVerificationStep(
        b as never,
        missing.specFor(b.id),
        new AbortController().signal,
      ),
      (err: Error) => {
        assert.match(
          err.message,
          /^baseline-check-failed: `no-such-check-command-xyz` could not run on the base commit [0-9a-f]{12} \(.*ENOENT.*\)/,
        )
        assert.equal(
          classifyFailure({
            runId: 'r',
            status: 'failed',
            output: null,
            error: err.message,
            uncertain: [],
          })?.kind,
          'baseline-check-failed',
        )
        return true
      },
    )
  })
})
