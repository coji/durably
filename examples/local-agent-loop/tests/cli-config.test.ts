/**
 * The CLI boundary: `factory.json`, flag overrides, input files, validation
 * and the trigger-time snapshot.
 *
 * Each command runs the real CLI in a child process with `HOME` pointed at a
 * temporary directory, so the fixed state root resolves there and the
 * user's own database is never read or written.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { retriggerRun } from '../src/actions.js'
import {
  acquireWorkerLock,
  createAgentDurably,
  dbPath,
  probeWorkerLock,
  type AgentLoopDurably,
} from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { classifyFailure, classifyRun } from '../src/engine/failure-reasons.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import { BASELINE_INDEX_PRUNE_AGE_MS } from '../src/factory/baseline-reuse.js'
import {
  AGENT_LOOP_JOB_NAME,
  baselineMaxAgeMsSchema,
  specMaxRoundsSchema,
} from '../src/factory/job.js'
import { archiveMarkerOf, runRootOf } from '../src/factory/layout.js'
import { availableActions } from '../src/factory/policy.js'
import {
  codePrompt,
  reviewPrompt,
  triagePrompt,
} from '../src/factory/prompts.js'
import { REPAIR_OF_LABEL } from '../src/factory/repair.js'
import type { FactorySetup, FactoryState } from '../src/factory/types.js'
import { createTarget } from '../src/targets/index.js'
import {
  buildRepairInput,
  checkFailureFindings,
  incompleteReviewFindings,
  readRepairFiles,
  reloadTriggerInput,
  repairableCandidate,
  resolveProfiles,
  reviewFindings,
} from '../src/trigger-input.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsx = join(packageRoot, 'node_modules', '.bin', 'tsx')
const cli = join(packageRoot, 'src', 'cli.ts')

const BUGGY = `export function add(a, b) {
  return Math.trunc(a) + Math.trunc(b)
}
`

const SUITE = `import assert from 'node:assert/strict'
import { it } from 'node:test'

import { add } from '../src/calc.js'

it('adds decimals without truncation', () => {
  assert.equal(add(0.1, 0.2), 0.30000000000000004)
})
`

const CHECK = ['node', '--test', 'test/**/*.test.js']

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

interface Sandbox {
  root: string
  home: string
  repo: string
  stateRoot: string
}

async function sandbox(config?: unknown): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'cli-config-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  await mkdir(home)
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'test'), { recursive: true })
  await writeFile(join(repo, 'src', 'calc.js'), BUGGY)
  await writeFile(join(repo, 'test', 'calc.test.js'), SUITE)
  await writeFile(join(repo, 'package.json'), '{"type":"module"}\n')
  if (config !== undefined)
    await writeFile(join(repo, 'factory.json'), JSON.stringify(config))
  await git(root, ['init', '--initial-branch=main', 'repo'])
  await git(repo, ['config', 'user.email', 'test@localhost'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'seed'])
  return {
    root,
    home,
    repo,
    stateRoot: join(home, '.local', 'state', 'local-agent-loop'),
  }
}

async function demo(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
) {
  return runChild(tsx, [cli, ...args], {
    cwd: box.root,
    timeoutMs: 60000,
    maxOutputChars: 10_000_000,
    env: {
      HOME: box.home,
      // Must not move the database anywhere.
      DURABLY_DB: join(box.root, 'durably-db-override.db'),
      // No worker unless a test starts one: a run stays where the command
      // left it. A test that exercises the auto-started worker overrides it.
      LOCAL_AGENT_LOOP_NO_AUTO_WORKER: '1',
      ...env,
    },
  })
}

async function trigger(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  const res = await demo(box, ['trigger', ...args], env)
  assert.equal(res.code, 0, res.stderr)
  const out = JSON.parse(res.stdout) as { runId: string; db: string }
  assert.equal(out.db, dbPath(box.stateRoot))
  return out.runId
}

async function rejected(
  box: Sandbox,
  args: string[],
  message: RegExp,
  env: Record<string, string> = {},
) {
  const res = await demo(box, ['trigger', ...args], env)
  assert.notEqual(res.code, 0, `expected failure for ${args.join(' ')}`)
  assert.match(res.stderr, message)
  // Validation happens before the run, and before the database, exist.
  assert.equal(existsSync(dbPath(box.stateRoot)), false)
}

type RunInput = {
  provider: string
  checkTimeoutMs?: number
  agentTimeoutMs?: number
  agentIdleTimeoutMs?: number
  codexPath?: string | null
  configSource?: { path: string | null; explicit?: boolean }
  profiles: Record<
    string,
    {
      provider: string
      requestedModel: string | null
      requestedEffort: string | null
    }
  >
  target: {
    task: string
    spec: string | null
    dispositions: string | null
    baseRef: string
    checkCommand: string[] | null
    setupCommand: string[] | null
    inputFiles: Record<string, { path: string } | null>
    baselineCheck?: boolean
    baselineReuse?: { maxAgeMs: number } | null
    parallelReview?: boolean
    selfCheck?: string[][] | null
    testProbe?: { glob: string; command: string[] }[] | null
    reviewBlockerThreshold?: number | null
    commit?: {
      authorName: string | null
      authorEmail: string | null
      messageTemplate: string | null
      publishSquashed: boolean
    }
  }
}

async function inputOf(box: Sandbox, runId: string): Promise<RunInput> {
  const durably = createAgentDurably({ stateRoot: box.stateRoot })
  try {
    await durably.migrate()
    return (await durably.getRun(runId))?.input as RunInput
  } finally {
    await durably.db.destroy()
  }
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('factory.json and input files', { timeout: 180000 }, () => {
  it('runs from factory.json and a task file alone, fixed at trigger', async () => {
    const box = await sandbox({ check: CHECK })
    const task = 'Fix add() so decimal inputs are not truncated.\n'
    const spec = 'add() returns the exact floating point sum.\n'
    const dispositions = 'Earlier finding about mul() was out of scope.\n'
    await writeFile(join(box.root, 'task.md'), task)
    await writeFile(join(box.root, 'spec.md'), spec)
    await writeFile(join(box.root, 'dispositions.md'), dispositions)
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task-file',
      'task.md',
      '--spec-file',
      'spec.md',
      '--dispositions-file',
      'dispositions.md',
    ])

    // Rewrite every source after the trigger: the run must not notice.
    await writeFile(join(box.repo, 'factory.json'), '{"check":["false"]}')
    await writeFile(join(box.root, 'task.md'), 'DIFFERENT TASK\n')
    await writeFile(join(box.root, 'spec.md'), 'DIFFERENT SPEC\n')
    await writeFile(join(box.root, 'dispositions.md'), 'DIFFERENT\n')

    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    try {
      const deadline = Date.now() + 150000
      for (;;) {
        const status = (await durably.getRun(runId))?.status
        if (status === 'completed' || status === 'failed') break
        if (Date.now() > deadline) throw new Error('run did not finish')
        // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
        await new Promise((r) => setTimeout(r, 500))
      }
      const run = await durably.getRun(runId)
      assert.equal(run?.status, 'completed', run?.error ?? '')
      const output = run?.output as {
        conclusion: string
        delivery: { branch: string | null; commit: string | null }
      }
      assert.equal(output.conclusion, 'approved')

      const input = run?.input as RunInput
      assert.deepEqual(input.target.checkCommand, CHECK)
      assert.equal(input.target.task, task)
      // The run stores paths only; hashes come from the stored content.
      assert.deepEqual(Object.keys(input.target.inputFiles['task'] ?? {}), [
        'path',
      ])

      // The prompts are built from the stored setup, not from the files.
      const steps = await durably.storage.getSteps(runId)
      const setup = steps.find((s) => s.name === 'setup')
        ?.output as FactorySetup
      const target = createTarget(setup.target)
      const code = codePrompt({
        role: 'implement',
        iteration: 1,
        repairNotes: [],
        task: target.taskBrief(),
        rules: target.implementationRules(),
        untrusted: target.untrustedInputs('code'),
      })
      assert.ok(code.includes(task.trimEnd()))
      assert.ok(code.includes(spec.trimEnd()))
      assert.ok(!code.includes(dispositions.trimEnd()))
      const review = reviewPrompt(
        'edge-cases',
        '',
        target.reviewRules('edge-cases'),
        target.untrustedInputs('edge-cases'),
      )
      assert.ok(review.includes(dispositions.trimEnd()))
      assert.ok(!review.includes('DIFFERENT'))
      // Triage would see the stored task and spec, never the dispositions.
      const triage = triagePrompt(
        target.taskBrief(),
        target.untrustedInputs('code'),
      )
      assert.ok(triage.includes(task.trimEnd()))
      assert.ok(triage.includes(spec.trimEnd()))
      assert.ok(!triage.includes(dispositions.trimEnd()))

      // Report and status name the hashes, the branch and the commit.
      const report = await buildReport(durably, runId)
      for (const text of [reportToMarkdown(report), reportToJson(report)]) {
        assert.ok(text.includes(sha256(task)))
        assert.ok(text.includes(sha256(spec)))
        assert.ok(text.includes(sha256(dispositions)))
        assert.ok(text.includes(`factory/${runId}`))
        assert.ok(text.includes(output.delivery.commit ?? 'missing'))
      }
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }

    const status = await demo(box, ['status', '--run', runId])
    assert.equal(status.code, 0, status.stderr)
    const shown = JSON.parse(status.stdout) as {
      delivery: { branch: string; commit: string }
      candidate: { branch: string; commit: string }
    }
    assert.deepEqual(
      [shown.candidate.branch, shown.candidate.commit],
      [shown.delivery.branch, shown.delivery.commit],
    )
    assert.equal(shown.delivery.branch, `factory/${runId}`)
    assert.equal(
      shown.delivery.commit,
      (await git(box.repo, ['rev-parse', `factory/${runId}`])).trim(),
    )

    // One fixed state root; nothing in the repository, the checkout, or
    // wherever DURABLY_DB pointed.
    assert.ok(
      existsSync(join(box.stateRoot, 'runs', runId, 'operation-checkpoints')),
    )
    // The delivered run's worktree was removed once the delivery was
    // recorded; its branch is the way back to the work.
    assert.equal(existsSync(join(box.stateRoot, 'runs', runId, 'work')), false)
    assert.equal(existsSync(join(box.root, 'durably-db-override.db')), false)
    assert.equal(existsSync(join(box.repo, 'runs')), false)
    assert.deepEqual(
      readdirSync(box.repo).filter((name) => name.endsWith('.db')),
      [],
    )
    assert.equal(existsSync(join(packageRoot, 'runs', runId)), false)
  })

  it('selects a config outside the repository with --config', async () => {
    const box = await sandbox()
    await writeFile(
      join(box.root, 'elsewhere.json'),
      JSON.stringify({ check: ['node', '--test'], base: 'main' }),
    )
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'do it',
      '--config',
      'elsewhere.json',
    ])
    const input = await inputOf(box, runId)
    assert.deepEqual(input.target.checkCommand, ['node', '--test'])
    assert.equal(input.target.baseRef, 'main')
  })

  it('lets --check, --setup and --base override the config', async () => {
    const box = await sandbox({
      check: ['false'],
      setup: ['false'],
      base: 'no-such-ref',
    })
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'do it',
      '--check',
      'node --test test/calc.test.js',
      '--setup',
      'true',
      '--base',
      'HEAD',
    ])
    const input = await inputOf(box, runId)
    assert.deepEqual(input.target.checkCommand, [
      'node',
      '--test',
      'test/calc.test.js',
    ])
    assert.deepEqual(input.target.setupCommand, ['true'])
    assert.equal(input.target.baseRef, 'HEAD')
  })

  it('fills only what the config leaves out from --provider, --model and --effort', async () => {
    const box = await sandbox({
      check: CHECK,
      profiles: {
        code: { provider: 'fake', model: 'model-a' },
        review: { 'edge-cases': { model: 'model-b', effort: 'high' } },
      },
    })
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'do it',
      '--provider',
      'fake',
      '--model',
      'fallback-model',
      '--effort',
      'low',
    ])
    const { profiles } = await inputOf(box, runId)
    const pick = (role: string) => [
      profiles[role]?.provider,
      profiles[role]?.requestedModel,
      profiles[role]?.requestedEffort,
    ]
    assert.deepEqual(pick('code'), ['fake', 'model-a', 'low'])
    assert.deepEqual(pick('correctness'), ['fake', 'fallback-model', 'low'])
    assert.deepEqual(pick('edge-cases'), ['fake', 'model-b', 'high'])
  })

  it("gives a role on another provider that provider's default, not the flags", async () => {
    const box = await sandbox({
      check: CHECK,
      profiles: { review: { 'edge-cases': { provider: 'claude' } } },
    })
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'do it',
      '--provider',
      'codex',
      '--model',
      'gpt-5.6-terra',
      '--effort',
      'high',
    ])
    const { profiles } = await inputOf(box, runId)
    const pick = (role: string) => [
      profiles[role]?.provider,
      profiles[role]?.requestedModel,
      profiles[role]?.requestedEffort,
    ]
    assert.deepEqual(pick('code'), ['codex', 'gpt-5.6-terra', 'high'])
    assert.deepEqual(pick('edge-cases'), ['claude', null, null])
    // Only requested settings are stored; the worker resolves the rest.
    assert.equal('effectiveModel' in (profiles['code'] ?? {}), false)
    // No triage profile in the config: the run has none.
    assert.equal('triage' in profiles, false)
  })

  it('stores a triage profile only when the config names one, fixed at trigger', async () => {
    const box = await sandbox({
      check: CHECK,
      profiles: { triage: { model: 'triage-model' } },
    })
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'do it',
      '--provider',
      'fake',
      '--effort',
      'low',
    ])
    // Changing the config afterwards does not reach the run.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({
        check: CHECK,
        profiles: { triage: { model: 'other' } },
      }),
    )
    const { profiles } = await inputOf(box, runId)
    assert.deepEqual(profiles['triage'], {
      provider: 'fake',
      requestedModel: 'triage-model',
      requestedEffort: 'low',
    })
    // An empty object still turns triage on, with the fallback settings.
    const empty = await sandbox({ check: CHECK, profiles: { triage: {} } })
    const emptyRun = await trigger(empty, [
      '--repo',
      empty.repo,
      '--task',
      'do it',
    ])
    assert.deepEqual((await inputOf(empty, emptyRun)).profiles['triage'], {
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
    })
  })
})

async function until(
  cond: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 150000
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** The status listing is one block per run, separated by blank lines. */
function blockOf(stdout: string, runId: string): string {
  return stdout.split('\n\n').find((b) => b.startsWith(runId)) ?? ''
}

describe('status without --run', { timeout: 180000 }, () => {
  it('lists open and stopped runs with the next command, and leftover worktrees', async () => {
    const box = await sandbox({ check: CHECK })
    const empty = await demo(box, ['status'])
    assert.equal(empty.code, 0, empty.stderr)
    assert.match(empty.stdout, /No runs need attention/)
    const emptyJson = await demo(box, ['status', '--format', 'json'])
    assert.equal(emptyJson.code, 0, emptyJson.stderr)
    assert.deepEqual(JSON.parse(emptyJson.stdout).tasks, [])
    assert.notEqual((await demo(box, ['status', '--format', 'yaml'])).code, 0)

    // A repository run that finishes, and one whose setup fails before any
    // worktree is recorded.
    const done = await trigger(box, ['--repo', box.repo, '--task', 'fix add'])
    const noSetup = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'fix add',
      '--base',
      'no-such-ref',
    ])
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.migrate()
    const subject = async () =>
      (
        await durably.jobs.agentLoop.trigger({
          provider: 'fake',
          target: { kind: 'subject' as const },
          maxIterations: 2,
          context: 'reuse',
        })
      ).id
    let waiting = ''
    let waitId = ''
    let pending = ''
    let live = ''
    let expired = ''
    let workdir = ''
    let repoPath = ''
    try {
      // The bundled sample waits for a human approval.
      waiting = await subject()
      await durably.init()
      const status = (id: string) => async () =>
        (await durably.getRun(id))?.status
      await until(
        async () => (await status(done)()) === 'completed',
        'repo run completes',
      )
      await until(
        async () => (await status(noSetup)()) === 'failed',
        'bad base fails',
      )
      await until(
        async () => (await status(waiting)()) === 'waiting',
        'sample waits',
      )
      await durably.stop()
      waitId = (await durably.getWaits(waiting)).find(
        (w) => w.status === 'pending',
      )?.id as string
      assert.ok(waitId)
      const setup = (await durably.storage.getCompletedStep(done, 'setup'))
        ?.output as FactorySetup
      assert.equal(setup.target.kind, 'repo')
      if (setup.target.kind === 'repo') {
        workdir = setup.target.workdir
        repoPath = setup.target.repoPath
      }
      // The delivered run removed its worktree. One from before that did
      // not: made again here, it is the leftover `status` points at.
      assert.equal(existsSync(workdir), false)
      const delivered = (await durably.getRun(done))?.output as {
        delivery: { commit: string }
      }
      await git(repoPath, [
        'worktree',
        'add',
        '--detach',
        workdir,
        delivered.delivery.commit,
      ])
      // With no worker running: one queued run, one held by a live lease and
      // one whose lease has run out.
      pending = await subject()
      live = await subject()
      expired = await subject()
      const lease = (id: string, expiresAt: Date) =>
        durably.db
          .updateTable('durably_runs')
          .set({
            status: 'leased',
            lease_owner: 'other-worker',
            lease_expires_at: expiresAt.toISOString(),
          })
          .where('id', '=', id)
          .execute()
      await lease(live, new Date(Date.now() + 3_600_000))
      await lease(expired, new Date(Date.now() - 60_000))
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }

    const res = await demo(box, ['status'])
    assert.equal(res.code, 0, res.stderr)
    const out = res.stdout
    // Printed commands run as pasted from anywhere in the repository; any
    // explanation follows as a shell comment.
    const demoCmd = 'pnpm --filter example-local-agent-loop demo'
    const approve = `${demoCmd} approve --run ${waiting} --wait ${waitId}`
    const reject = `${demoCmd} reject --run ${waiting} --wait ${waitId}`
    for (const line of out.split('\n')) {
      const cmd = line.match(/^ {2}(?:next:| {5}|cleanup:) +(.*)$/)?.[1]
      if (!cmd) continue
      assert.ok(
        cmd.startsWith(`${demoCmd} `) || cmd.startsWith('git -C '),
        line,
      )
      assert.doesNotMatch(cmd.split('  #')[0] ?? '', /[()]/, line)
    }
    assert.ok(blockOf(out, waiting).includes(approve), out)
    assert.ok(blockOf(out, waiting).includes(reject), out)
    assert.match(blockOf(out, pending), /pending[\s\S]*queued/)
    assert.match(blockOf(out, live), /a worker is running it/)
    assert.match(blockOf(out, expired), /lease expired/)
    assert.match(blockOf(out, expired), /demo worker/)
    // Only the run with an approval wait is offered approve or reject, and
    // an open run is never called retryable.
    for (const id of [pending, live, expired, noSetup, done]) {
      assert.doesNotMatch(blockOf(out, id), /demo (approve|reject)/)
    }
    for (const id of [pending, live, expired])
      assert.doesNotMatch(blockOf(out, id), /retry:/)
    assert.match(blockOf(out, noSetup), /unclassified[\s\S]*retry: +NO/)
    // The delivered repository run's worktree is still on disk, though its
    // run should have removed it: offer `demo prune --apply`, which forces
    // the removal and prunes the registration, not a git removal that a
    // worktree with changes refuses. The run that failed before setup and
    // the sample run get none.
    const prune = `cleanup: ${demoCmd} prune --apply  # forces the removal`
    assert.ok(blockOf(out, done).includes(prune), out)
    assert.doesNotMatch(out, /worktree remove|branch -D/)
    for (const id of [noSetup, waiting, pending, live, expired])
      assert.doesNotMatch(blockOf(out, id), /cleanup:/)

    // Once the worktree is gone, the run is not mentioned again.
    await git(repoPath, ['worktree', 'remove', workdir])
    const after = await demo(box, ['status'])
    assert.equal(after.code, 0, after.stderr)
    assert.equal(blockOf(after.stdout, done), '')
    assert.doesNotMatch(after.stdout, /cleanup:/)

    // The run-specific view keeps its fields and adds the diagnosis.
    const one = await demo(box, ['status', '--run', waiting])
    assert.equal(one.code, 0, one.stderr)
    const shown = JSON.parse(one.stdout) as Record<string, unknown> & {
      diagnosis: { next: string[] }
    }
    for (const key of [
      'diagnosis',
      'delivery',
      'candidate',
      'run',
      'attempts',
      'waits',
    ])
      assert.ok(key in shown, key)
    assert.ok(shown.diagnosis.next.includes(approve))

    // Once approved, with no worker running, the run is still waiting but
    // its decision is recorded: no second approve, and a worker resumes it.
    const approved = await demo(box, [
      'approve',
      '--run',
      waiting,
      '--wait',
      waitId,
    ])
    assert.equal(approved.code, 0, approved.stderr)
    const decided = blockOf((await demo(box, ['status'])).stdout, waiting)
    assert.match(decided, /waiting/)
    assert.match(decided, /decision on candidate .* is recorded \(approved\)/)
    assert.match(decided, /demo worker/)
    assert.doesNotMatch(decided, /demo (approve|reject)|not a candidate/)
  })
})

/** Every row of the tables a run lives in, to prove nothing was written. */
function rows(box: Sandbox): string {
  const db = new Database(dbPath(box.stateRoot), { readonly: true })
  try {
    return JSON.stringify(
      [
        'durably_runs',
        'durably_steps',
        'durably_step_attempts',
        'durably_waits',
        'durably_run_labels',
      ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),
    )
  } finally {
    db.close()
  }
}

describe('archive and unarchive', { timeout: 120000 }, () => {
  it('moves a stopped run out of the attention list by a marker alone, and back', async () => {
    const box = await sandbox()
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    let stopped = ''
    let pending = ''
    let delivered = ''
    try {
      await durably.migrate()
      const subject = async () =>
        (
          await durably.jobs.agentLoop.trigger({
            provider: 'fake',
            target: { kind: 'subject' as const },
            maxIterations: 1,
            context: 'reuse',
          })
        ).id
      stopped = await subject()
      await durably.cancel(stopped)
      pending = await subject()
      // Approved and delivered: it needs no one, so there is nothing to archive.
      delivered = await subject()
      await durably.db
        .updateTable('durably_runs')
        .set({
          status: 'completed',
          output: JSON.stringify({ approved: true, conclusion: 'approved' }),
        })
        .where('id', '=', delivered)
        .execute()
    } finally {
      await durably.db.destroy()
    }
    const marker = archiveMarkerOf(box.stateRoot, stopped)
    const status = async () => {
      const res = await demo(box, ['status'])
      assert.equal(res.code, 0, res.stderr)
      return res.stdout
    }
    const before = await status()
    const block = blockOf(before, stopped)
    assert.match(block, /cancelled/)

    // Refused without a run, for an unknown run, and for one still open.
    assert.match((await demo(box, ['archive'])).stderr, /--run <id> required/)
    assert.match(
      (await demo(box, ['archive', '--run', 'nope'])).stderr,
      /no run nope/,
    )
    const open = await demo(box, ['archive', '--run', pending])
    assert.notEqual(open.code, 0)
    assert.match(open.stderr, /it is pending, not stopped/)
    assert.equal(existsSync(archiveMarkerOf(box.stateRoot, pending)), false)
    const finished = await demo(box, ['archive', '--run', delivered])
    assert.notEqual(finished.code, 0)
    assert.match(
      finished.stderr,
      /refusing to archive \S+: it finished \(approved\) and needs no one; only a stopped run is archived/,
    )
    assert.equal(existsSync(archiveMarkerOf(box.stateRoot, delivered)), false)

    const snapshot = rows(box)
    const archived = await demo(box, ['archive', '--run', stopped])
    assert.equal(archived.code, 0, archived.stderr)
    assert.match(archived.stdout, /^archived /)
    assert.ok(existsSync(marker))
    // The run's record is exactly as it was.
    assert.equal(rows(box), snapshot)
    const after = await status()
    assert.equal(blockOf(after, stopped), '')
    assert.match(after, /1 stopped run\(s\) archived:/)
    assert.ok(after.includes(`demo unarchive --run ${stopped}`))
    const json = await demo(box, ['status', '--format', 'json'])
    const task = (
      JSON.parse(json.stdout) as {
        tasks: {
          id: string
          attention: string
          runs: { kind: string; archived: boolean }[]
        }[]
      }
    ).tasks.find((t) => t.id === stopped)
    assert.deepEqual(
      [task?.attention, task?.runs[0]?.kind, task?.runs[0]?.archived],
      ['done', 'stopped', true],
    )
    assert.match(
      (await demo(box, ['archive', '--run', stopped])).stdout,
      /already archived/,
    )

    const back = await demo(box, ['unarchive', '--run', stopped])
    assert.equal(back.code, 0, back.stderr)
    assert.equal(existsSync(marker), false)
    assert.equal(rows(box), snapshot)
    assert.equal(blockOf(await status(), stopped), block)
    assert.match(
      (await demo(box, ['unarchive', '--run', stopped])).stdout,
      /not archived/,
    )
  })
})

describe('archive --series', { timeout: 300000 }, () => {
  /** A fake subject run, a repair of `parent` when one is named. */
  const subjectRun = async (durably: AgentLoopDurably, parent?: string) =>
    (
      await durably.jobs.agentLoop.trigger(
        {
          provider: 'fake',
          target: { kind: 'subject' as const },
          maxIterations: 1,
          context: 'reuse',
        },
        parent ? { labels: { [REPAIR_OF_LABEL]: parent } } : {},
      )
    ).id

  it('archives each task a repeated --series names, past one that fails, and unarchive takes a repeated --run', async () => {
    const box = await sandbox()
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    let one = ''
    let two = ''
    try {
      await durably.migrate()
      one = await subjectRun(durably)
      await durably.cancel(one)
      two = await subjectRun(durably)
      await durably.cancel(two)
    } finally {
      await durably.db.destroy()
    }
    const marked = () =>
      [one, two].filter((id) => existsSync(archiveMarkerOf(box.stateRoot, id)))
    const res = await demo(box, [
      'archive',
      '--series',
      one,
      '--series',
      'nope',
      '--series',
      two,
    ])
    // The missing task fails the command, after the others are archived.
    assert.notEqual(res.code, 0)
    assert.match(res.stderr, /no run nope/)
    assert.deepEqual(marked(), [one, two])
    const back = await demo(box, ['unarchive', '--run', one, '--run', two])
    assert.equal(back.code, 0, back.stderr)
    assert.ok(back.stdout.includes(`unarchived ${one}`))
    assert.ok(back.stdout.includes(`unarchived ${two}`))
    assert.deepEqual(marked(), [])
  })

  it('archives every stop of the task any of its runs names, leaves its other runs and other tasks, and status counts the stops left', async () => {
    const box = await sandbox()
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    let first = ''
    let repair = ''
    let grandchild = ''
    let waiting = ''
    let running = ''
    let pending = ''
    let delivered = ''
    let other = ''
    try {
      await durably.migrate()
      const set = (
        id: string,
        values: {
          status: 'waiting' | 'leased' | 'completed'
          lease_owner?: string
          lease_generation?: number
          lease_expires_at?: string
          created_at?: string
          output?: string
        },
      ) =>
        durably.db
          .updateTable('durably_runs')
          .set(values)
          .where('id', '=', id)
          .execute()
      // One task: a first run, its repair and that repair's repair stopped,
      // and runs that wait on a person, run, are queued, or were delivered.
      first = await subjectRun(durably)
      await durably.cancel(first)
      repair = await subjectRun(durably, first)
      await durably.cancel(repair)
      grandchild = await subjectRun(durably, repair)
      await durably.cancel(grandchild)
      waiting = await subjectRun(durably, grandchild)
      await set(waiting, { status: 'waiting' })
      running = await subjectRun(durably, first)
      await set(running, {
        status: 'leased',
        lease_owner: 'elsewhere',
        lease_generation: 1,
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      pending = await subjectRun(durably, grandchild)
      // Approved and delivered after `grandchild`, from the same parent: it
      // replaces that stop, which still counts as not archived.
      delivered = await subjectRun(durably, repair)
      await set(delivered, {
        status: 'completed',
        created_at: new Date(Date.now() + 1000).toISOString(),
        output: JSON.stringify({
          approved: true,
          conclusion: 'approved',
          delivery: {
            kind: 'patch',
            location: join(box.root, 'delivery.patch'),
            summary: 'delivered',
          },
        }),
      })
      // Another task, stopped.
      other = await subjectRun(durably)
      await durably.cancel(other)
    } finally {
      await durably.db.destroy()
    }
    const stops = [first, repair, grandchild]
    const rest = [waiting, running, pending, delivered, other]
    const marked = () =>
      [...stops, ...rest].filter((id) =>
        existsSync(archiveMarkerOf(box.stateRoot, id)),
      )
    const status = async () => {
      const res = await demo(box, ['status'])
      assert.equal(res.code, 0, res.stderr)
      return res.stdout
    }
    const stopsLine = (count: number, task: string) =>
      `  stops:   ${count} stopped run(s) not archived; pnpm --filter example-local-agent-loop demo archive --series ${task}  #`
    const unarchiveAll = async () => {
      for (const id of stops)
        assert.equal((await demo(box, ['unarchive', '--run', id])).code, 0)
      assert.deepEqual(marked(), [])
    }

    // Each task block counts its stops, the replaced one too, and names the
    // first run.
    const before = await status()
    assert.match(before, /^2 task\(s\) wait on a person or stopped unresolved:/)
    const block = blockOf(before, waiting)
    assert.ok(block.includes(stopsLine(3, first)), block)
    assert.ok(block.includes(`, replaced by a later approved repair`), block)
    assert.ok(blockOf(before, other).includes(stopsLine(1, other)))
    // The JSON task data keeps its shape.
    type JsonTask = { id: string; runs: Record<string, unknown>[] }
    const jsonTasks = async () => {
      const res = await demo(box, ['status', '--format', 'json'])
      assert.equal(res.code, 0, res.stderr)
      return (JSON.parse(res.stdout) as { tasks: JsonTask[] }).tasks
    }
    for (const task of await jsonTasks()) {
      assert.deepEqual(Object.keys(task), [
        'id',
        'attention',
        'representative',
        'runs',
        'fake',
        'latestAt',
        'total',
      ])
      for (const run of task.runs)
        assert.deepEqual(Object.keys(run), [
          'id',
          'parentId',
          'kind',
          'approved',
          'repair',
          'superseded',
          'archived',
          'attention',
        ])
    }

    // Refused with both flags, with neither, without an ID and for a run
    // that is not there; nothing is archived.
    const both = await demo(box, ['archive', '--series', first, '--run', first])
    assert.notEqual(both.code, 0)
    assert.match(both.stderr, /--run and --series exclude each other/)
    const neither = await demo(box, ['archive'])
    assert.notEqual(neither.code, 0)
    assert.match(neither.stderr, /--run <id> required/)
    const bare = await demo(box, ['archive', '--series'])
    assert.notEqual(bare.code, 0)
    assert.match(bare.stderr, /--series <id> required/)
    const missing = await demo(box, ['archive', '--series', 'nope'])
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /no run nope/)
    assert.deepEqual(marked(), [])

    // `--run` still takes one stopped run, and refuses any other.
    const open = await demo(box, ['archive', '--run', pending])
    assert.notEqual(open.code, 0)
    assert.match(
      open.stderr,
      /refusing to archive \S+: it is pending, not stopped/,
    )
    const one = await demo(box, ['archive', '--run', first])
    assert.equal(one.code, 0, one.stderr)
    assert.match(
      one.stdout,
      new RegExp(`^archived ${first}; status and the web UI`),
    )
    assert.deepEqual(marked(), [first])
    assert.ok(blockOf(await status(), waiting).includes(stopsLine(2, first)))

    // From the grandchild: every stop of its task, the one already archived
    // again; nothing else, and no run's record changes.
    const snapshot = rows(box)
    const series = await demo(box, ['archive', '--series', grandchild])
    assert.equal(series.code, 0, series.stderr)
    assert.ok(series.stdout.includes(`${first}: already archived`))
    for (const id of [repair, grandchild])
      assert.ok(series.stdout.includes(`${id}: archived. Undo with`), id)
    assert.match(
      series.stdout,
      new RegExp(
        `task ${first}: 3 stopped run\\(s\\) archived, 4 other run\\(s\\) left as they are \\(not stopped\\)`,
      ),
    )
    assert.deepEqual(marked().sort(), [...stops].sort())
    assert.equal(rows(box), snapshot)
    // The task still waits on a person, so it stays at the top, with no
    // stops left to count; the other task is as it was.
    const after = await status()
    assert.match(after, /^2 task\(s\) wait on a person or stopped unresolved:/)
    const left = blockOf(after, waiting)
    assert.ok(left.startsWith(`${waiting}  waiting`), left)
    assert.doesNotMatch(left, /stops:/)
    for (const id of stops)
      assert.match(left, new RegExp(`also:    ${id} .*, archived`))
    assert.ok(blockOf(after, other).includes(stopsLine(1, other)))
    // The delivered run reads as before.
    const deliveredRun = (await jsonTasks())
      .find((t) => t.id === first)
      ?.runs.find((r) => r['id'] === delivered)
    assert.deepEqual(
      [
        deliveredRun?.['kind'],
        deliveredRun?.['approved'],
        deliveredRun?.['archived'],
      ],
      ['finished', true, false],
    )

    // From the repair, and from the delivered run, the same stops.
    for (const from of [repair, delivered, first]) {
      await unarchiveAll()
      const res = await demo(box, ['archive', '--series', from])
      assert.equal(res.code, 0, res.stderr)
      assert.deepEqual(marked().sort(), [...stops].sort(), from)
    }

    // A task whose only open matter was its stop leaves the top.
    const last = await demo(box, ['archive', '--series', other])
    assert.equal(last.code, 0, last.stderr)
    const done = await status()
    assert.match(done, /^1 task\(s\) wait on a person or stopped unresolved:/)
    assert.equal(blockOf(done, other), '')
    assert.match(done, /4 stopped run\(s\) archived:/)
  })

  it('cleans up each stop of the task, again when already archived, and deletes branches only with --delete-branch', async () => {
    const box = await sandbox()
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    let first = ''
    let repair = ''
    let other = ''
    const work = (id: string) => join(runRootOf(box.stateRoot, id), 'work')
    try {
      await durably.migrate()
      first = await subjectRun(durably)
      repair = await subjectRun(durably, first)
      other = await subjectRun(durably)
      // Each a stopped repository run with the worktree and branch its
      // setup recorded.
      for (const id of [first, repair, other]) {
        await durably.cancel(id)
        const workdir = work(id)
        await git(box.repo, ['worktree', 'add', '-b', `factory/${id}`, workdir])
        const now = new Date().toISOString()
        await durably.db
          .insertInto('durably_steps')
          .values({
            id: `setup-${id}`,
            run_id: id,
            name: 'setup',
            index: 0,
            status: 'completed',
            output: JSON.stringify({
              target: {
                kind: 'repo',
                repoPath: box.repo,
                workdir,
                branch: `factory/${id}`,
              },
            }),
            error: null,
            started_at: now,
            completed_at: now,
          })
          .execute()
      }
    } finally {
      await durably.db.destroy()
    }
    const branch = async (id: string) =>
      (
        await runChild(
          'git',
          ['rev-parse', '--verify', '--quiet', `refs/heads/factory/${id}`],
          { cwd: box.repo, timeoutMs: 60000 },
        )
      ).code === 0

    // A locked worktree: git refuses, the run is archived anyway, and the
    // warning names its run. Without --delete-branch every branch stays.
    await git(box.repo, ['worktree', 'lock', work(first)])
    const locked = await demo(box, ['archive', '--series', repair])
    assert.equal(locked.code, 0, locked.stderr)
    assert.ok(locked.stdout.includes(`${repair}: removed its worktree`))
    assert.match(
      locked.stderr,
      new RegExp(`warning: ${first}: worktree .*locked`),
    )
    assert.ok(
      locked.stderr.includes(
        `run pnpm --filter example-local-agent-loop demo archive --series ${repair} again to retry`,
      ),
    )
    assert.ok(existsSync(work(first)))
    assert.equal(existsSync(work(repair)), false)
    for (const id of [first, repair, other]) assert.ok(await branch(id), id)

    // Again, unlocked and with --delete-branch: the archived runs are
    // cleaned up once more and their branches deleted.
    await git(box.repo, ['worktree', 'unlock', work(first)])
    const again = await demo(box, [
      'archive',
      '--series',
      first,
      '--delete-branch',
    ])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(again.stderr, '')
    for (const id of [first, repair]) {
      assert.ok(again.stdout.includes(`${id}: already archived`), id)
      assert.ok(
        again.stdout.includes(`${id}: deleted branches: factory/${id}`),
        id,
      )
      assert.equal(await branch(id), false, id)
    }
    assert.ok(again.stdout.includes(`${first}: removed its worktree`))
    assert.equal(existsSync(work(first)), false)
    // The other task keeps its worktree, its branch and no marker.
    assert.ok(existsSync(work(other)))
    assert.ok(await branch(other))
    assert.equal(existsSync(archiveMarkerOf(box.stateRoot, other)), false)
  })

  it('archives the other stops when one run of the task cannot be diagnosed, names it and exits nonzero', async () => {
    const box = await sandbox()
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    let first = ''
    let broken = ''
    let last = ''
    try {
      await durably.migrate()
      first = await subjectRun(durably)
      await durably.cancel(first)
      broken = await subjectRun(durably, first)
      await durably.cancel(broken)
      last = await subjectRun(durably, broken)
      await durably.cancel(last)
      // A setup step whose stored output is not JSON: reading it throws, so
      // diagnosing this one run fails.
      const now = new Date().toISOString()
      await durably.db
        .insertInto('durably_steps')
        .values({
          id: `setup-${broken}`,
          run_id: broken,
          name: 'setup',
          index: 0,
          status: 'completed',
          output: '{not json',
          error: null,
          started_at: now,
          completed_at: now,
        })
        .execute()
    } finally {
      await durably.db.destroy()
    }

    const res = await demo(box, ['archive', '--series', first])
    assert.notEqual(res.code, 0)
    for (const id of [first, last]) {
      assert.ok(res.stdout.includes(`${id}: archived. Undo with`), id)
      assert.ok(existsSync(archiveMarkerOf(box.stateRoot, id)), id)
    }
    assert.equal(existsSync(archiveMarkerOf(box.stateRoot, broken)), false)
    assert.match(
      res.stdout,
      new RegExp(
        `task ${first}: 2 stopped run\\(s\\) archived, 0 other run\\(s\\) left as they are \\(not stopped\\), 1 run\\(s\\) not archived`,
      ),
    )
    assert.match(res.stderr, new RegExp(`^${broken}: .*JSON`, 'm'))
    assert.match(
      res.stderr,
      new RegExp(`could not diagnose or archive every run of task ${first}`),
    )
    assert.ok(!res.stderr.includes('again to retry'), res.stderr)
  })
})

describe('retrigger from the stored input', () => {
  it('starts one run per stopped run with its labels, a repair child with its parent, and refuses a stop unsafe to repeat', async () => {
    const input = { target: { kind: 'repo' }, repairOf: { runId: 'parent' } }
    const stored = {
      child: {
        id: 'child',
        status: 'failed',
        input,
        output: null,
        error:
          'candidate-moved: candidate branch factory/parent moved to 0123456789ab',
      },
      broken: {
        id: 'broken',
        status: 'failed',
        input,
        output: null,
        error: 'boom',
      },
    }
    const calls: unknown[] = []
    const durably = {
      getRun: async (id: keyof typeof stored) => stored[id] ?? null,
      getStepAttempts: async () => [],
      storage: {
        getCompletedStep: async () => null,
        getSteps: async () => [],
      },
      jobs: {
        agentLoop: {
          trigger: async (i: unknown, options: unknown) => {
            calls.push([i, options])
            return { id: 'next', disposition: 'created' }
          },
        },
      },
    } as unknown as AgentLoopDurably
    assert.deepEqual(await retriggerRun(durably, 'child'), {
      runId: 'next',
      disposition: 'created',
    })
    assert.deepEqual(calls, [
      [
        input,
        {
          idempotencyKey: 'retrigger-of-child',
          labels: { [REPAIR_OF_LABEL]: 'parent' },
        },
      ],
    ])
    await assert.rejects(
      retriggerRun(durably, 'broken'),
      /refusing to retrigger broken/,
    )
    await assert.rejects(retriggerRun(durably, 'gone' as never), /no run gone/)
    assert.equal(calls.length, 1)
  })
})

describe('trigger validation', { timeout: 120000 }, () => {
  it('requires a check from the config or the flags', async () => {
    const box = await sandbox()
    await rejected(
      box,
      ['--repo', box.repo, '--task', 'do it'],
      /check command is required/,
    )
  })

  it('rejects conflicting or empty task sources', async () => {
    const box = await sandbox({ check: CHECK })
    await writeFile(join(box.root, 'task.md'), 'do it\n')
    await writeFile(join(box.root, 'empty.md'), '  \n')
    await rejected(
      box,
      ['--repo', box.repo, '--task-file', 'task.md', '--task', 'x'],
      /not --task and --task-file/,
    )
    await rejected(
      box,
      ['--repo', box.repo, '--task-file', 'task.md', '--issue', '1'],
      /not --issue and --task-file/,
    )
    await rejected(
      box,
      ['--repo', box.repo, '--task-file', 'empty.md'],
      /empty/,
    )
    await rejected(
      box,
      ['--repo', box.repo, '--task', 'x', '--spec-file', 'empty.md'],
      /empty/,
    )
    await rejected(box, ['--repo', box.repo], /--task-file/)
  })

  it('rejects an input file over 256 KiB', async () => {
    const box = await sandbox({ check: CHECK })
    await writeFile(join(box.root, 'big.md'), 'x'.repeat(256 * 1024 + 1))
    await writeFile(join(box.root, 'edge.md'), 'x'.repeat(256 * 1024))
    await rejected(
      box,
      ['--repo', box.repo, '--task', 'x', '--spec-file', 'big.md'],
      /--spec-file big\.md: file is 262145 bytes; the limit is 256 KiB/,
    )
    await trigger(box, ['--repo', box.repo, '--task-file', 'edge.md'])
  })

  it('rejects a bad config, a bad effort, and mixed fake and real roles', async () => {
    const box = await sandbox({ check: CHECK, profiles: { code: { tier: 1 } } })
    await rejected(
      box,
      ['--repo', box.repo, '--task', 'x'],
      /invalid factory config/,
    )
    const mixed = await sandbox({
      check: CHECK,
      profiles: { code: { provider: 'codex' } },
    })
    await rejected(
      mixed,
      ['--repo', mixed.repo, '--task', 'x'],
      /cannot mix the fake provider/,
    )
    // Triage is held to the same rule, in both directions.
    const realTriage = await sandbox({
      check: CHECK,
      profiles: { triage: { provider: 'codex' } },
    })
    await rejected(
      realTriage,
      ['--repo', realTriage.repo, '--task', 'x'],
      /cannot mix the fake provider .*\(fake: code, correctness, edge-cases\)/,
    )
    const fakeTriage = await sandbox({
      check: CHECK,
      profiles: { triage: { provider: 'fake' } },
    })
    await rejected(
      fakeTriage,
      ['--repo', fakeTriage.repo, '--task', 'x', '--provider', 'codex'],
      /cannot mix the fake provider .*\(fake: triage\)/,
    )
    const effort = await sandbox({ check: CHECK })
    await rejected(
      effort,
      ['--repo', effort.repo, '--task', 'x', '--provider', 'codex'].concat([
        '--effort',
        'bogus',
      ]),
      /unsupported Codex effort/,
    )
  })

  it('rejects commit settings of the wrong type, empty, or unknown', async () => {
    for (const commit of [
      { authorName: '' },
      { authorEmail: '   ' },
      { messageTemplate: '' },
      { authorName: 3 },
      { publishSquashed: 'yes' },
      { authorname: 'typo' },
      'Factory Bot',
    ]) {
      const box = await sandbox({ check: CHECK, commit })
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x'],
        /invalid factory config[\s\S]*commit/,
      )
    }
  })

  it('does not document DURABLY_DB', async () => {
    const box = await sandbox()
    const res = await demo(box, ['--help'])
    assert.equal(res.code, 0)
    assert.doesNotMatch(res.stdout, /DURABLY_DB/)
    assert.match(res.stdout, /\.local\/state\/local-agent-loop/)
    assert.match(res.stdout, /factory\.json/)
  })
})

describe('settings fixed at trigger', { timeout: 180000 }, () => {
  it('stores the timeouts: config first, then the trigger environment, then the default', async () => {
    const box = await sandbox({
      check: CHECK,
      checkTimeoutMs: 45000,
      agentTimeoutMs: 600000,
      agentIdleTimeoutMs: 120000,
    })
    const fromConfig = await trigger(box, ['--repo', box.repo, '--task', 'x'], {
      TEST_TIMEOUT_MS: '1',
      AGENT_TIMEOUT_MS: '1',
      AGENT_IDLE_TIMEOUT_MS: '1',
    })
    const configured = await inputOf(box, fromConfig)
    assert.equal(configured.checkTimeoutMs, 45000)
    assert.equal(configured.agentTimeoutMs, 600000)
    assert.equal(configured.agentIdleTimeoutMs, 120000)

    const plain = await sandbox({ check: CHECK })
    const fromEnv = await trigger(
      plain,
      ['--repo', plain.repo, '--task', 'x'],
      {
        TEST_TIMEOUT_MS: '30000',
        AGENT_TIMEOUT_MS: '400000',
        AGENT_IDLE_TIMEOUT_MS: '200000',
      },
    )
    const env = await inputOf(plain, fromEnv)
    assert.equal(env.checkTimeoutMs, 30000)
    assert.equal(env.agentTimeoutMs, 400000)
    assert.equal(env.agentIdleTimeoutMs, 200000)
    // A shorter total holds the default idle limit to itself.
    const short = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x'], {
        AGENT_TIMEOUT_MS: '400000',
      }),
    )
    assert.equal(short.agentIdleTimeoutMs, 400000)
    // Neither: the target's own default, fixed all the same.
    const byDefault = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(byDefault.checkTimeoutMs, 900000)
    assert.equal(byDefault.agentTimeoutMs, 7200000)
    assert.equal(byDefault.agentIdleTimeoutMs, 900000)
    const subject = await inputOf(plain, await trigger(plain, []))
    assert.equal(subject.checkTimeoutMs, 120000)
    assert.equal(subject.agentTimeoutMs, 300000)
    assert.equal(subject.agentIdleTimeoutMs, 300000)

    // The worker's environment no longer reaches a stored run: a 1 ms agent
    // timeout would fail every call, and the run still completes with the
    // values fixed at trigger.
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    process.env.TEST_TIMEOUT_MS = '1'
    process.env.AGENT_TIMEOUT_MS = '1'
    process.env.AGENT_IDLE_TIMEOUT_MS = '1'
    const durably = createAgentDurably({ stateRoot: plain.stateRoot })
    await durably.init()
    try {
      await until(
        async () =>
          ['completed', 'failed'].includes(
            (await durably.getRun(fromEnv))?.status ?? '',
          ),
        'run with fixed timeouts settles',
      )
      const run = await durably.getRun(fromEnv)
      assert.equal(run?.status, 'completed', run?.error ?? '')
      const setup = (await durably.storage.getCompletedStep(fromEnv, 'setup'))
        ?.output as FactorySetup
      assert.equal(setup.agentTimeoutMs, 400000)
      assert.equal(setup.agentIdleTimeoutMs, 200000)
      assert.equal(
        setup.target.kind === 'repo' ? setup.target.checkTimeoutMs : null,
        30000,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.TEST_TIMEOUT_MS
      delete process.env.AGENT_TIMEOUT_MS
      delete process.env.AGENT_IDLE_TIMEOUT_MS
    }
  })

  it('refuses a timeout that is not a positive safe integer', async () => {
    // 2^31 ms and up overflow Node's timers and fire after about 1 ms.
    for (const bad of [0, -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER + 2]) {
      for (const key of [
        'checkTimeoutMs',
        'agentTimeoutMs',
        'agentIdleTimeoutMs',
      ]) {
        const box = await sandbox({ check: CHECK, [key]: bad })
        await rejected(
          box,
          ['--repo', box.repo, '--task', 'x'],
          new RegExp(`invalid factory config[\\s\\S]*${key}`),
        )
      }
    }
    const box = await sandbox({ check: CHECK })
    for (const bad of [
      '0',
      '-5',
      '1.5',
      'NaN',
      'Infinity',
      '2147483648',
      '9007199254740993',
      '',
    ]) {
      for (const name of [
        'TEST_TIMEOUT_MS',
        'AGENT_TIMEOUT_MS',
        'AGENT_IDLE_TIMEOUT_MS',
      ])
        await rejected(
          box,
          ['--repo', box.repo, '--task', 'x'],
          new RegExp(`${name} must be a positive integer`),
          { [name]: bad },
        )
    }
  })

  it('refuses an idle limit longer than the total, from the config or the environment', async () => {
    const tooLong = await sandbox({
      check: CHECK,
      agentTimeoutMs: 600000,
      agentIdleTimeoutMs: 600001,
    })
    await rejected(
      tooLong,
      ['--repo', tooLong.repo, '--task', 'x'],
      /agentIdleTimeoutMs \(600001 ms\) must not be longer than agentTimeoutMs \(600000 ms\)/,
    )
    const box = await sandbox({ check: CHECK })
    await rejected(
      box,
      ['--repo', box.repo, '--task', 'x'],
      /must not be longer than agentTimeoutMs/,
      { AGENT_TIMEOUT_MS: '60000', AGENT_IDLE_TIMEOUT_MS: '60001' },
    )
    // The bundled sample too.
    await rejected(box, [], /must not be longer than agentTimeoutMs/, {
      AGENT_IDLE_TIMEOUT_MS: '300001',
    })
    // Equal is allowed.
    const equal = await inputOf(
      box,
      await trigger(box, ['--repo', box.repo, '--task', 'x'], {
        AGENT_TIMEOUT_MS: '60000',
        AGENT_IDLE_TIMEOUT_MS: '60000',
      }),
    )
    assert.equal(equal.agentIdleTimeoutMs, 60000)
  })

  it('fixes the commit settings at trigger, applies them, and reads them again only on a reload', async () => {
    const commit = {
      authorName: 'Factory Bot',
      authorEmail: 'bot@example.com',
      messageTemplate: 'fix: {task} ({iteration})',
    }
    const box = await sandbox({ check: CHECK, commit })
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'Fix add() for decimals\nThey must not be truncated.',
    ])
    const stored = await inputOf(box, runId)
    assert.deepEqual(stored.target.commit, {
      ...commit,
      publishSquashed: false,
    })
    // Edited after the trigger: the run keeps what it stored.
    const changed = {
      authorName: 'Someone Else',
      authorEmail: 'else@example.com',
      messageTemplate: 'chore: {runId}',
      publishSquashed: true,
    }
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, commit: changed }),
    )

    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    let squashedCommit = ''
    try {
      await until(
        async () => (await durably.getRun(runId))?.status === 'completed',
        'commit-settings run completes',
      )
      const run = await durably.getRun(runId)
      const output = run?.output as {
        conclusion: string
        delivery: { squashedBranch: string; squashedCommit: string }
      }
      assert.equal(output.conclusion, 'approved')
      const setup = (await durably.storage.getSteps(runId)).find(
        (x) => x.name === 'setup',
      )?.output as FactorySetup
      assert.equal(setup.target.kind, 'repo')
      if (setup.target.kind === 'repo')
        assert.deepEqual(setup.target.commit, stored.target.commit)
      const log = (ref: string) =>
        git(box.repo, ['log', '--format=%an <%ae>|%s', `main..${ref}`])
      const expected =
        'Factory Bot <bot@example.com>|fix: Fix add() for decimals (1)\n'
      assert.equal(await log(`factory/${runId}`), expected)
      const squashed = `factory/${runId}-squashed`
      assert.equal(output.delivery.squashedBranch, squashed)
      assert.equal(await log(squashed), expected)
      squashedCommit = output.delivery.squashedCommit

      const report = await buildReport(durably, runId)
      assert.equal(report.delivery?.squashedBranch, squashed)
      assert.ok(
        reportToMarkdown(report).includes(`- squashed branch: ${squashed}`),
      )
      const json = JSON.parse(reportToJson(report)) as {
        delivery: { squashedBranch: string; squashedCommit: string }
      }
      assert.deepEqual(
        [json.delivery.squashedBranch, json.delivery.squashedCommit],
        [squashed, squashedCommit],
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }

    const status = await demo(box, ['status', '--run', runId])
    assert.equal(status.code, 0, status.stderr)
    const shown = JSON.parse(status.stdout) as {
      delivery: { squashedBranch: string; squashedCommit: string }
    }
    assert.deepEqual(
      [shown.delivery.squashedBranch, shown.delivery.squashedCommit],
      [`factory/${runId}-squashed`, squashedCommit],
    )

    // A reload reads the edited file; the stored run is untouched.
    const reloaded = await reloadTriggerInput(
      stored as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.deepEqual(
      (reloaded.input.target as { commit?: unknown }).commit,
      changed,
    )
    assert.deepEqual((await inputOf(box, runId)).target.commit, {
      ...commit,
      publishSquashed: false,
    })

    // Left out: every field at its default.
    const plain = await sandbox({ check: CHECK })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.deepEqual(plainInput.target.commit, {
      authorName: null,
      authorEmail: null,
      messageTemplate: null,
      publishSquashed: false,
    })
  })

  it('fixes baselineCheck and a checked, absolute codexPath', async () => {
    const box = await sandbox()
    await mkdir(join(box.root, 'config', 'bin'), { recursive: true })
    const codex = join(box.root, 'config', 'bin', 'codex')
    await writeFile(codex, '#!/bin/sh\nexit 0\n')
    await chmod(codex, 0o755)
    const config = join(box.root, 'config', 'factory.json')
    await writeFile(
      config,
      JSON.stringify({
        check: CHECK,
        baselineCheck: true,
        codexPath: 'bin/codex',
      }),
    )
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'x',
      '--config',
      config,
    ])
    const input = await inputOf(box, runId)
    // Relative to the config file, not to where the command ran.
    assert.equal(input.codexPath, codex)
    assert.equal(input.target.baselineCheck, true)

    // Left out: no pin, so PATH then the bundled CLI, and no
    // baseline check.
    const plain = await sandbox({ check: CHECK })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(plainInput.codexPath, null)
    assert.equal(plainInput.target.baselineCheck, false)

    // A path that is missing, a directory, or not executable fails before
    // the run exists.
    const text = join(box.root, 'config', 'bin', 'notes.txt')
    await writeFile(text, 'not a program\n')
    for (const [path, why] of [
      ['bin/missing', /file not found/],
      ['bin', /not a regular file/],
      ['bin/notes.txt', /not executable/],
    ] as const) {
      const bad = await sandbox()
      const badConfig = join(
        box.root,
        'config',
        `bad-${why.source.length}.json`,
      )
      await writeFile(
        badConfig,
        JSON.stringify({ check: CHECK, codexPath: path }),
      )
      await rejected(
        bad,
        ['--repo', bad.repo, '--task', 'x', '--config', badConfig],
        why,
      )
    }
  })

  it('fixes baselineReuse at trigger, refuses a bad maxAgeMs, and reloads it', async () => {
    const box = await sandbox({
      check: CHECK,
      baselineCheck: true,
      baselineReuse: { maxAgeMs: 3_600_000 },
    })
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'x'])
    const input = await inputOf(box, runId)
    assert.deepEqual(input.target.baselineReuse, { maxAgeMs: 3_600_000 })

    // Left out: none, so every baseline check runs.
    const plain = await sandbox({ check: CHECK, baselineCheck: true })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(plainInput.target.baselineReuse, null)

    // Zero, a sign, a fraction, past the pruning horizon (7 days), Infinity
    // (`1e400` in JSON) and a missing value are refused before the run.
    for (const raw of [
      '0',
      '-1',
      '1.5',
      String(BASELINE_INDEX_PRUNE_AGE_MS + 1),
      '1e400',
      'null',
    ]) {
      const bad = await sandbox()
      await writeFile(
        join(bad.repo, 'factory.json'),
        `{"check":${JSON.stringify(CHECK)},"baselineCheck":true,"baselineReuse":{"maxAgeMs":${raw}}}`,
      )
      await rejected(
        bad,
        ['--repo', bad.repo, '--task', 'x'],
        /invalid factory config[\s\S]*maxAgeMs/,
      )
    }
    // NaN and Infinity cannot be written in JSON; a direct trigger's input
    // is held to the same schema.
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      BASELINE_INDEX_PRUNE_AGE_MS + 1,
    ])
      assert.equal(baselineMaxAgeMsSchema.safeParse(value).success, false)
    // Exactly the pruning horizon (7 days) is accepted; one millisecond more
    // is refused, since an index entry that old is pruned before it could
    // ever be reused.
    assert.equal(
      baselineMaxAgeMsSchema.safeParse(BASELINE_INDEX_PRUNE_AGE_MS).success,
      true,
    )
    assert.equal(
      baselineMaxAgeMsSchema.safeParse(BASELINE_INDEX_PRUNE_AGE_MS + 1).success,
      false,
    )

    // A reload reads the value the file has now, and its absence.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({
        check: CHECK,
        baselineCheck: true,
        baselineReuse: { maxAgeMs: 60_000 },
      }),
    )
    const reuseOf = (t: { kind: string }) =>
      'baselineReuse' in t ? t.baselineReuse : undefined
    const reloaded = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.deepEqual(reuseOf(reloaded.input.target), { maxAgeMs: 60_000 })
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, baselineCheck: true }),
    )
    const dropped = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.equal(reuseOf(dropped.input.target), null)
  })
})

describe('parallelReview', { timeout: 180000 }, () => {
  it('fixes the setting at trigger, off when left out, reloads it, and passes it to a repair', async () => {
    const on = await sandbox({ check: CHECK, parallelReview: true })
    const input = await inputOf(
      on,
      await trigger(on, ['--repo', on.repo, '--task', 'x']),
    )
    assert.equal(input.target.parallelReview, true)
    const plain = await sandbox({ check: CHECK })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(plainInput.target.parallelReview, false)
    // Anything but a boolean is refused before the run.
    const bad = await sandbox({ check: CHECK, parallelReview: 'yes' })
    await rejected(
      bad,
      ['--repo', bad.repo, '--task', 'x'],
      /invalid factory config[\s\S]*parallelReview/,
    )
    // A reload reads the file as it is now.
    await writeFile(
      join(on.repo, 'factory.json'),
      JSON.stringify({ check: CHECK }),
    )
    const reloaded = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.equal(
      (reloaded.input.target as { parallelReview?: boolean }).parallelReview,
      false,
    )
  })

  it('gives a repair run the setting its parent was set up with', () => {
    const commit = 'a'.repeat(40)
    const profile = (role: string) => ({
      id: `fake:provider-default:provider-default:${role}`,
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
    })
    const parent = (parallelReview?: boolean) => ({
      id: 'p',
      status: 'completed',
      input: {
        provider: 'fake',
        target: {
          kind: 'repo',
          ...(parallelReview === undefined ? {} : { parallelReview }),
        },
      },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    })
    const setup = {
      contextMode: 'reuse',
      maxIterations: 1,
      agentTimeoutMs: 600000,
      autoApprove: true,
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
      },
      target: {
        kind: 'repo',
        repoPath: '/repo',
        task: 'task',
        spec: null,
        dispositions: null,
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        checkTimeoutMs: 120000,
        publish: false,
      },
    }
    const files = {
      findings: { content: 'FINDING\n', ref: { path: '/f.md' } },
      dispositions: null,
    }
    const repair = (p: ReturnType<typeof parent>, s: object) =>
      buildRepairInput(p, s, files).input.target.parallelReview
    assert.equal(repair(parent(true), { ...setup, parallelReview: true }), true)
    // Setup records it only when on; a parent without it is off.
    assert.equal(repair(parent(false), setup), false)
    assert.equal(repair(parent(), setup), false)
  })
})

describe('selfCheck', { timeout: 240000 }, () => {
  const LINT = ['node', '--check', 'src/calc.js']
  const five = [1, 2, 3, 4, 5].map((n) => ['node', '-e', `${n}`])

  it('stores one to five argv commands at trigger, null when left out, and reloads them', async () => {
    const one = await sandbox({ check: CHECK, selfCheck: [LINT] })
    const input = await inputOf(
      one,
      await trigger(one, ['--repo', one.repo, '--task', 'x']),
    )
    assert.deepEqual(input.target.selfCheck, [LINT])
    const most = await sandbox({ check: CHECK, selfCheck: five })
    const mostInput = await inputOf(
      most,
      await trigger(most, ['--repo', most.repo, '--task', 'x']),
    )
    assert.deepEqual(mostInput.target.selfCheck, five)
    const plain = await sandbox({ check: CHECK })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(plainInput.target.selfCheck, null)
    // `retrigger --reload-config` reads the file as it is now.
    await writeFile(
      join(one.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, selfCheck: [['node', '-v']] }),
    )
    const reloaded = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.deepEqual(
      (reloaded.input.target as { selfCheck?: unknown }).selfCheck,
      [['node', '-v']],
    )
    await writeFile(
      join(one.repo, 'factory.json'),
      JSON.stringify({ check: CHECK }),
    )
    const dropped = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.equal(
      (dropped.input.target as { selfCheck?: unknown }).selfCheck,
      null,
    )
  })

  it('refuses an empty list, more than five, an empty command, an empty or non-string argument', async () => {
    for (const selfCheck of [
      [],
      [...five, ['node', '-e', '6']],
      [[]],
      [['pnpm', '']],
      [['']],
      [['pnpm', 1]],
      ['pnpm lint'],
    ]) {
      const box = await sandbox({ check: CHECK, selfCheck })
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x'],
        /invalid factory config[\s\S]*selfCheck/,
      )
    }
  })

  it('keeps the commands fixed at trigger in the prompt, and gives them to a repair run whatever factory.json says now', async () => {
    const box = await sandbox({ check: CHECK, selfCheck: [LINT] })
    const parentId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the parent task',
      '--max-iterations',
      '1',
    ])
    // Edited after trigger: the run never reads it.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, selfCheck: [['node', '-v']] }),
    )
    process.env.FAKE_FAIL_FIRST = '0'
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    let setup: FactorySetup
    try {
      await until(
        async () => (await durably.getRun(parentId))?.status === 'completed',
        'the parent completes',
      )
      setup = (await durably.storage.getCompletedStep(parentId, 'setup'))
        ?.output as FactorySetup
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
    assert.equal(setup.target.kind, 'repo')
    const rules = createTarget(setup.target).implementationRules()
    const prompt = codePrompt({
      role: 'implement',
      iteration: 1,
      repairNotes: [],
      task: 'x',
      rules,
    })
    assert.ok(prompt.includes('`node --check src/calc.js`'))
    assert.ok(!prompt.includes('`node -v`'))
    // A repair run takes the parent's value, not the edited file's.
    await writeFile(join(box.root, 'findings.md'), 'FINDING: refunds\n')
    const res = await demo(box, [
      'repair',
      '--run',
      parentId,
      '--findings-file',
      'findings.md',
    ])
    assert.equal(res.code, 0, res.stderr)
    const child = await inputOf(
      box,
      (JSON.parse(res.stdout) as { runId: string }).runId,
    )
    assert.deepEqual(child.target.selfCheck, [LINT])
  })

  it("gives a repair run its parent's value, absence included", () => {
    const commit = 'a'.repeat(40)
    const profile = (role: string) => ({
      id: `fake:provider-default:provider-default:${role}`,
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
    })
    const parent = {
      id: 'p',
      status: 'completed',
      input: { provider: 'fake', target: { kind: 'repo' } },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    }
    const setup = (selfCheck?: string[][] | null) => ({
      contextMode: 'reuse',
      maxIterations: 5,
      agentTimeoutMs: 600000,
      autoApprove: true,
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
      },
      target: {
        kind: 'repo',
        repoPath: '/repo',
        task: 'task',
        spec: null,
        dispositions: null,
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        ...(selfCheck === undefined ? {} : { selfCheck }),
        checkTimeoutMs: 120000,
        publish: false,
      },
    })
    const files = {
      findings: { content: 'FINDING\n', ref: { path: '/f.md' } },
      dispositions: null,
    }
    const child = (s: object) => buildRepairInput(parent, s, files).input
    assert.deepEqual(child(setup([LINT])).target.selfCheck, [LINT])
    assert.equal(child(setup(null)).target.selfCheck, null)
    assert.equal(child(setup()).target.selfCheck, null)
    // The inherited limit, 5 included, is the child's own.
    assert.equal(child(setup()).maxIterations, 5)
  })
})

describe('testProbe', { timeout: 240000 }, () => {
  const PROBE = [
    { glob: 'test/**/*.test.js', command: ['node', '--test', '{files}'] },
  ]
  const OTHER = [{ glob: 'spec/**', command: ['node', '-e', '1', '{files}'] }]

  it('stores the entries at trigger, null when left out, and reloads them', async () => {
    const box = await sandbox({ check: CHECK, testProbe: PROBE })
    const input = await inputOf(
      box,
      await trigger(box, ['--repo', box.repo, '--task', 'x']),
    )
    assert.deepEqual(input.target.testProbe, PROBE)
    const plain = await sandbox({ check: CHECK })
    const plainInput = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(plainInput.target.testProbe, null)
    // `retrigger --reload-config` reads the file as it is now.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, testProbe: OTHER }),
    )
    const reloaded = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.deepEqual(
      (reloaded.input.target as { testProbe?: unknown }).testProbe,
      OTHER,
    )
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK }),
    )
    const dropped = await reloadTriggerInput(
      input as unknown as Parameters<typeof reloadTriggerInput>[0],
    )
    assert.equal(
      (dropped.input.target as { testProbe?: unknown }).testProbe,
      null,
    )
  })

  it('refuses an empty list, a command without a whole {files} element, an empty glob or command, unknown keys, more than 20 entries and a glob over 200 characters', async () => {
    for (const testProbe of [
      [],
      Array.from({ length: 21 }, (_, i) => ({
        glob: `test/${i}/**`,
        command: ['node', '{files}'],
      })),
      [{ glob: `test/${'x'.repeat(196)}`, command: ['node', '{files}'] }],
      [{ glob: 'test/**', command: ['node', '--test'] }],
      [{ glob: 'test/**', command: ['node', '--test={files}'] }],
      [{ glob: 'test/**', command: [] }],
      [{ glob: '', command: ['node', '{files}'] }],
      [{ glob: 'test/**', command: ['node', '', '{files}'] }],
      [{ glob: 'test/**', command: 'node --test {files}' }],
      [{ glob: 'test/**', command: ['node', '{files}'], shell: true }],
    ]) {
      const box = await sandbox({ check: CHECK, testProbe })
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x'],
        /invalid factory config[\s\S]*testProbe/,
      )
    }
  })

  it('keeps the entries fixed at trigger for the worker, and gives them to a repair run whatever factory.json says now', async () => {
    const box = await sandbox({ check: CHECK, testProbe: PROBE })
    const parentId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the parent task',
      '--max-iterations',
      '1',
    ])
    // Edited after trigger: the run never reads it.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, testProbe: OTHER }),
    )
    process.env.FAKE_FAIL_FIRST = '0'
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    let setup: FactorySetup
    let probed: string[]
    try {
      await until(
        async () => (await durably.getRun(parentId))?.status === 'completed',
        'the parent completes',
      )
      setup = (await durably.storage.getCompletedStep(parentId, 'setup'))
        ?.output as FactorySetup
      probed = (await durably.storage.getSteps(parentId))
        .map((s) => s.name)
        .filter((name) => name.endsWith(':test-probe'))
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
    assert.equal(setup.target.kind, 'repo')
    if (setup.target.kind !== 'repo') throw new Error('repo target expected')
    assert.deepEqual(setup.target.testProbe, PROBE)
    assert.equal(probed.length, 1)
    // A repair run takes the parent's value, not the edited file's.
    await writeFile(join(box.root, 'findings.md'), 'FINDING: refunds\n')
    const res = await demo(box, [
      'repair',
      '--run',
      parentId,
      '--findings-file',
      'findings.md',
    ])
    assert.equal(res.code, 0, res.stderr)
    const child = await inputOf(
      box,
      (JSON.parse(res.stdout) as { runId: string }).runId,
    )
    assert.deepEqual(child.target.testProbe, PROBE)
  })
})

describe('review.blockerThreshold', { timeout: 240000 }, () => {
  const thresholdOf = async (box: Sandbox) =>
    (
      await inputOf(
        box,
        await trigger(box, ['--repo', box.repo, '--task', 'x']),
      )
    ).target.reviewBlockerThreshold

  it('fixes 5 when left out, takes 0 to 100, and reads the file again only on a reload', async () => {
    assert.equal(await thresholdOf(await sandbox({ check: CHECK })), 5)
    assert.equal(
      await thresholdOf(await sandbox({ check: CHECK, review: {} })),
      5,
    )
    for (const blockerThreshold of [0, 1, 100])
      assert.equal(
        await thresholdOf(
          await sandbox({ check: CHECK, review: { blockerThreshold } }),
        ),
        blockerThreshold,
      )
    const box = await sandbox({ check: CHECK, review: { blockerThreshold: 8 } })
    const input = await inputOf(
      box,
      await trigger(box, ['--repo', box.repo, '--task', 'x']),
    )
    assert.equal(input.target.reviewBlockerThreshold, 8)
    const reload = async (config: unknown) => {
      await writeFile(join(box.repo, 'factory.json'), JSON.stringify(config))
      const reloaded = await reloadTriggerInput(
        input as unknown as Parameters<typeof reloadTriggerInput>[0],
      )
      return (reloaded.input.target as { reviewBlockerThreshold?: unknown })
        .reviewBlockerThreshold
    }
    assert.equal(
      await reload({ check: CHECK, review: { blockerThreshold: 12 } }),
      12,
    )
    assert.equal(await reload({ check: CHECK }), 5)
  })

  it('refuses a negative, 101, a fraction, Infinity, an unsafe integer, a non-number and unknown keys before the run exists', async () => {
    for (const review of [
      '{ "blockerThreshold": -1 }',
      '{ "blockerThreshold": 101 }',
      '{ "blockerThreshold": 2.5 }',
      // What JSON gives for a number too large to hold.
      '{ "blockerThreshold": 1e400 }',
      '{ "blockerThreshold": 9007199254740993 }',
      '{ "blockerThreshold": "5" }',
      '{ "blockerThreshold": null }',
      '{ "blockerThreshold": 5, "other": 1 }',
      '5',
    ]) {
      const box = await sandbox()
      await writeFile(
        join(box.repo, 'factory.json'),
        `{ "check": ${JSON.stringify(CHECK)}, "review": ${review} }`,
      )
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x'],
        /invalid factory config[\s\S]*review/,
      )
    }
  })

  it('keeps the threshold fixed at trigger for the worker, names it in the config version, and gives it to a repair run whatever factory.json says now', async () => {
    const box = await sandbox({ check: CHECK })
    const task = (id: string) => [
      '--repo',
      box.repo,
      '--task',
      `the ${id} task`,
      '--max-iterations',
      '1',
    ]
    const byDefault = await trigger(box, task('default'))
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, review: { blockerThreshold: 9 } }),
    )
    const nine = await trigger(box, task('nine'))
    // Edited after both triggers: neither run reads it.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: CHECK, review: { blockerThreshold: 40 } }),
    )
    process.env.FAKE_FAIL_FIRST = '0'
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    const setups: FactorySetup[] = []
    try {
      for (const id of [byDefault, nine]) {
        await until(
          async () => (await durably.getRun(id))?.status === 'completed',
          `run ${id} completes`,
        )
        setups.push(
          (await durably.storage.getCompletedStep(id, 'setup'))
            ?.output as FactorySetup,
        )
      }
      const report = await buildReport(durably, nine)
      assert.equal(report.reviewBlockerThreshold, 9)
      assert.match(
        reportToMarkdown(report),
        /- review blocker threshold: 9 \(a product-behavior finding whose likelihood × impact is below it is a non-blocker\)/,
      )
      assert.match(reportToJson(report), /"reviewBlockerThreshold": 9/)
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
    assert.deepEqual(
      setups.map((s) => s.reviewBlockerThreshold),
      [5, 9],
    )
    assert.notEqual(setups[0]?.configVersion, setups[1]?.configVersion)
    // A repair run takes the parent's value, not the edited file's.
    await writeFile(join(box.root, 'findings.md'), 'FINDING: refunds\n')
    const res = await demo(box, [
      'repair',
      '--run',
      nine,
      '--findings-file',
      'findings.md',
    ])
    assert.equal(res.code, 0, res.stderr)
    const child = await inputOf(
      box,
      (JSON.parse(res.stdout) as { runId: string }).runId,
    )
    assert.equal(child.target.reviewBlockerThreshold, 9)
  })

  it("gives a repair run its parent's value, and no rule to a parent stored without one", () => {
    const commit = 'a'.repeat(40)
    const profile = (role: string) => ({
      id: `fake:provider-default:provider-default:${role}`,
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
    })
    const parent = (reviewBlockerThreshold?: number) => ({
      id: 'p',
      status: 'completed',
      input: {
        provider: 'fake',
        target: {
          kind: 'repo',
          ...(reviewBlockerThreshold === undefined
            ? {}
            : { reviewBlockerThreshold }),
        },
      },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    })
    const setup = {
      contextMode: 'reuse',
      maxIterations: 1,
      agentTimeoutMs: 600000,
      autoApprove: true,
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
      },
      target: {
        kind: 'repo',
        repoPath: '/repo',
        task: 'task',
        spec: null,
        dispositions: null,
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        checkTimeoutMs: 120000,
        publish: false,
      },
    }
    const files = {
      findings: { content: 'FINDING\n', ref: { path: '/f.md' } },
      dispositions: null,
    }
    const repair = (p: ReturnType<typeof parent>, s: object) =>
      buildRepairInput(p, s, files).input.target.reviewBlockerThreshold
    assert.equal(repair(parent(7), { ...setup, reviewBlockerThreshold: 7 }), 7)
    assert.equal(repair(parent(0), { ...setup, reviewBlockerThreshold: 0 }), 0)
    // A parent stored before it existed: set up with null, never the default.
    assert.equal(
      repair(parent(), { ...setup, reviewBlockerThreshold: null }),
      null,
    )
    // A setup from before it existed falls back to the parent's input.
    assert.equal(repair(parent(3), setup), 3)
    assert.equal(repair(parent(), setup), null)
  })
})

describe('--max-iterations', { timeout: 120000 }, () => {
  it('accepts 1 to 5, defaults to 2, and refuses 0 and 6', async () => {
    const box = await sandbox({ check: CHECK })
    const stored = async (args: string[]) =>
      (
        (await inputOf(
          box,
          await trigger(box, ['--repo', box.repo, '--task', 'x', ...args]),
        )) as RunInput & { maxIterations: number }
      ).maxIterations
    assert.equal(await stored([]), 2)
    assert.equal(await stored(['--max-iterations', '1']), 1)
    assert.equal(await stored(['--max-iterations', '5']), 5)
    const fresh = await sandbox({ check: CHECK })
    for (const value of ['0', '6'])
      await rejected(
        fresh,
        ['--repo', fresh.repo, '--task', 'x', '--max-iterations', value],
        /--max-iterations must be an integer between 1 and 5/,
      )
  })

  it("counts a repair run's own repairs against an inherited limit of 5", () => {
    const state = (iteration: number) =>
      ({
        outcome: null,
        candidate: { id: 'c' },
        verification: { targetId: 'c', passed: false },
        iteration,
        setup: {
          maxIterations: 5,
          repairOf: { runId: 'p', candidateCommit: 'a'.repeat(40) },
        },
      }) as unknown as FactoryState
    assert.deepEqual(availableActions(state(4)), ['code'])
    assert.deepEqual(availableActions(state(5)), ['stop'])
  })
})

describe('retrigger --reload-config', { timeout: 240000 }, () => {
  it('fixes an optional repair profile at trigger, and reloads a fixed one after a refused repair', async () => {
    // Without "repair" the run stores none: repair runs on code's profile.
    const plain = await sandbox({ check: CHECK })
    const plainRun = await trigger(plain, ['--repo', plain.repo, '--task', 'x'])
    assert.equal('repair' in (await inputOf(plain, plainRun)).profiles, false)
    // It is held to the same rules as any other role.
    const mixed = await sandbox({
      check: CHECK,
      profiles: { repair: { provider: 'codex' } },
    })
    await rejected(
      mixed,
      ['--repo', mixed.repo, '--task', 'x', '--provider', 'fake'],
      /cannot mix the fake provider/,
    )

    const box = await sandbox({
      check: CHECK,
      profiles: { repair: { model: 'rejects-repair' } },
    })
    const stopped = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the stored task',
      '--effort',
      'low',
    ])
    assert.deepEqual((await inputOf(box, stopped)).profiles['repair'], {
      provider: 'fake',
      requestedModel: 'rejects-repair',
      requestedEffort: 'low',
    })
    // The first implementation leaves the bug, so a repair is called, and
    // its profile refuses it.
    delete process.env.FAKE_FAIL_FIRST
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    try {
      await until(
        async () => (await durably.getRun(stopped))?.status === 'failed',
        'the refused repair stops the run',
      )
      const report = await buildReport(durably, stopped)
      assert.equal(report.failure?.kind, 'rejected-invocation')
      assert.equal(report.failure?.retryable, true)
      assert.ok(
        report.failure?.next.some((n) =>
          n.includes(`retrigger --run ${stopped} --reload-config`),
        ),
      )
      assert.match(reportToMarkdown(report), /- refusal: fake: the repair call/)
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
    const status = blockOf((await demo(box, ['status'])).stdout, stopped)
    assert.match(status, /rejected-invocation:[\s\S]*retry: +yes/)
    assert.match(status, /refusal: fake: the repair call on rejects-repair/)
    assert.match(
      status,
      new RegExp(`retrigger --run ${stopped} --reload-config`),
    )

    // The person fixes the repair profile; the reload reads it.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({
        check: CHECK,
        agentIdleTimeoutMs: 123000,
        profiles: { repair: { model: 'fixed-repair' } },
      }),
    )
    const created = await demo(box, [
      'retrigger',
      '--run',
      stopped,
      '--reload-config',
    ])
    assert.equal(created.code, 0, created.stderr)
    const nextId = /^new run (\S+)/.exec(created.stdout)?.[1] ?? ''
    const next = await inputOf(box, nextId)
    assert.equal(next.profiles['repair']?.requestedModel, 'fixed-repair')
    // The idle limit is read again with the rest of the config.
    assert.equal((await inputOf(box, stopped)).agentIdleTimeoutMs, 900000)
    assert.equal(next.agentIdleTimeoutMs, 123000)
    assert.equal(next.target.task, 'the stored task')
  })

  it('reads factory.json again, keeps the stored task, and starts one run per config version', async () => {
    const box = await sandbox({
      check: CHECK,
      profiles: { code: { provider: 'fake', model: 'unlisted-model' } },
    })
    const config = join(box.repo, 'factory.json')
    const stopped = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the stored task',
    ])
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    try {
      await until(
        async () => (await durably.getRun(stopped))?.status === 'failed',
        'preflight stops the run',
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
    const first = await inputOf(box, stopped)
    assert.match(
      (await demo(box, ['status'])).stdout,
      new RegExp(`retrigger --run ${stopped} --reload-config`),
    )

    // The person fixes the profile and the check in factory.json.
    const fixedCheck = ['node', '--test', 'test/calc.test.js']
    await writeFile(
      config,
      JSON.stringify({
        check: fixedCheck,
        profiles: { code: { provider: 'fake', model: 'fixed-model' } },
      }),
    )
    const reload = () =>
      demo(box, ['retrigger', '--run', stopped, '--reload-config'])
    const created = await reload()
    assert.equal(created.code, 0, created.stderr)
    const nextId = /^new run (\S+) with the input of /.exec(created.stdout)?.[1]
    assert.ok(nextId, created.stdout)
    const next = await inputOf(box, nextId)
    assert.deepEqual(next.target.checkCommand, fixedCheck)
    assert.equal(next.profiles['code']?.requestedModel, 'fixed-model')
    // Not the config: the stored task, and the roles it leaves out.
    assert.equal(next.target.task, 'the stored task')
    assert.equal(next.target.task, first.target.task)
    assert.deepEqual(
      next.profiles['correctness'],
      first.profiles['correctness'],
    )

    // The same config again: the run it already started, nothing new.
    const again = await reload()
    assert.equal(again.code, 0, again.stderr)
    assert.match(
      again.stdout,
      new RegExp(`^already retriggered as ${nextId} with this version of `),
    )

    // Without the flag the stored settings stay, for an environment fix.
    const plain = await demo(box, ['retrigger', '--run', stopped])
    assert.equal(plain.code, 0, plain.stderr)
    const plainId = /^new run (\S+)/.exec(plain.stdout)?.[1] ?? ''
    const kept = await inputOf(box, plainId)
    assert.deepEqual(kept.target.checkCommand, CHECK)
    assert.equal(kept.profiles['code']?.requestedModel, 'unlisted-model')

    // Another edit is another version: one more run, resolved and checked
    // as at trigger.
    await writeFile(
      config,
      JSON.stringify({
        check: fixedCheck,
        checkTimeoutMs: 45000,
        profiles: { code: { provider: 'fake', model: 'fixed-model' } },
      }),
    )
    const edited = await reload()
    assert.equal(edited.code, 0, edited.stderr)
    const editedId = /^new run (\S+)/.exec(edited.stdout)?.[1] ?? ''
    assert.notEqual(editedId, nextId)
    assert.equal((await inputOf(box, editedId)).checkTimeoutMs, 45000)
    await writeFile(
      config,
      JSON.stringify({ check: CHECK, agentTimeoutMs: 2 ** 31 }),
    )
    const invalid = await reload()
    assert.notEqual(invalid.code, 0)
    assert.match(invalid.stderr, /invalid factory config[\s\S]*agentTimeoutMs/)
  })

  it('says a check flag wins over factory.json, reads a removed default factory.json as none, and refuses a removed --config file', async () => {
    const box = await sandbox()
    const config = join(box.repo, 'factory.json')
    await writeFile(
      config,
      JSON.stringify({
        profiles: { code: { provider: 'fake', model: 'unlisted-model' } },
      }),
    )
    const flagCheck = ['node', '--test', 'test/calc.test.js']
    const args = [
      '--repo',
      box.repo,
      '--task',
      'the stored task',
      '--check',
      flagCheck.join(' '),
    ]
    const stopped = await trigger(box, args)
    // The same file, named by --config: a reload must find it again.
    const named = await trigger(box, [...args, '--config', config])
    assert.equal((await inputOf(box, named)).configSource?.explicit, true)
    assert.equal((await inputOf(box, stopped)).configSource?.explicit, false)
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    try {
      await until(
        async () =>
          (await durably.getRun(stopped))?.status === 'failed' &&
          (await durably.getRun(named))?.status === 'failed',
        'preflight stops both runs',
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
    assert.match(
      (await demo(box, ['status'])).stdout,
      /--reload-config {2}# after fixing factory\.json; the --check, --setup or --base given at trigger still wins over it/,
    )

    // The run read the default factory.json, which is now gone: the reload
    // carries on without a config, as a trigger would.
    await rm(config)
    const created = await demo(box, [
      'retrigger',
      '--run',
      stopped,
      '--reload-config',
    ])
    assert.equal(created.code, 0, created.stderr)
    const nextId = /^new run (\S+)/.exec(created.stdout)?.[1] ?? ''
    const next = await inputOf(box, nextId)
    assert.deepEqual(next.target.checkCommand, flagCheck)
    assert.notEqual(next.profiles['code']?.requestedModel, 'unlisted-model')

    // The file the other run named with --config is gone: an error, not a
    // silent fallback to no config.
    const missing = await demo(box, [
      'retrigger',
      '--run',
      named,
      '--reload-config',
    ])
    assert.notEqual(missing.code, 0)
    assert.match(missing.stderr, /--config .*factory\.json: file not found/)
  })
})

/** A worker process, with its output so far. */
function startWorker(
  box: Sandbox,
  env: Record<string, string> = {},
  flags: string[] = [],
) {
  const child = spawn(tsx, [cli, 'worker', ...flags], {
    cwd: box.root,
    // An idle worker never starts a successor unless a test asks for one.
    env: {
      ...process.env,
      HOME: box.home,
      FAKE_FAIL_FIRST: '0',
      LOCAL_AGENT_LOOP_NO_AUTO_WORKER: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr.on('data', (d: Buffer) => (out += d.toString()))
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  )
  // tsx runs the worker in a child of its own, so signals go to the pid
  // the worker prints, the process that holds the lock.
  const pid = () => Number(/worker running, pid (\d+)/.exec(out)?.[1])
  return {
    child,
    exited,
    output: () => out,
    pid,
    running: () => until(async () => Number.isInteger(pid()), 'worker starts'),
    kill: (signal: NodeJS.Signals) => {
      try {
        process.kill(pid(), signal)
      } catch {
        // Already gone.
      }
    },
  }
}

describe('one worker per state root', { timeout: 240000 }, () => {
  it('refuses a second worker, lets another root run, and survives kill -9 without rerunning a finished baseline', async () => {
    // The check reads gate files beside the repository: while `slow-base`
    // exists it hangs on the base commit, and while `slow-verify` exists it
    // hangs on a fixed candidate. Otherwise it passes at once.
    const box = await sandbox()
    const gates = join(box.root, 'gates')
    await mkdir(gates)
    const script = join(box.root, 'check.cjs')
    await writeFile(
      script,
      `const { existsSync, readFileSync } = require('node:fs')
const fixed = !readFileSync('src/calc.js', 'utf8').includes('Math.trunc')
const gate = ${JSON.stringify(gates)} + (fixed ? '/slow-verify' : '/slow-base')
process.stdout.write(fixed ? 'candidate\\n' : 'base\\n')
// Hang while the gate exists, so a worker can be killed mid-check; the
// orphaned check then ends on its own once the gate is gone.
const wait = setInterval(() => existsSync(gate) || clearInterval(wait), 100)
`,
    )
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: ['node', script], baselineCheck: true }),
    )
    await git(box.repo, ['add', '-A'])
    await git(box.repo, ['commit', '-m', 'config'])
    await writeFile(join(gates, 'slow-base'), '')
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'fix add'])
    const db = createAgentDurably({ stateRoot: box.stateRoot })
    await db.migrate()
    const attempts = async (name: string) =>
      (await db.getStepAttempts(runId)).filter((a) => a.stepName === name)
    const other = await sandbox()
    const workers: ReturnType<typeof startWorker>[] = []
    try {
      const first = startWorker(box)
      workers.push(first)
      await first.running()

      // Same state root: refused, naming the running worker.
      const second = startWorker(box)
      workers.push(second)
      assert.notEqual(await second.exited, 0)
      assert.match(second.output(), new RegExp(`pid ${first.pid()}\\b`))
      assert.ok(second.output().includes(packageRoot), second.output())
      // Another state root: no conflict.
      const elsewhere = startWorker(other)
      workers.push(elsewhere)
      await elsewhere.running()
      elsewhere.kill('SIGTERM')
      assert.equal(await elsewhere.exited, 0)

      // The first worker dies mid-baseline. Its note stays behind, but the
      // lock went with the process: the next worker starts.
      await until(
        async () => (await attempts('baseline')).length === 1,
        'baseline starts',
      )
      first.kill('SIGKILL')
      await first.exited
      assert.ok(existsSync(join(box.stateRoot, 'worker.json')))
      await rm(join(gates, 'slow-base'))
      await writeFile(join(gates, 'slow-verify'), '')
      const third = startWorker(box)
      workers.push(third)
      await third.running()
      // It reclaims the run, grades the base again, and dies mid-verify.
      await until(
        async () =>
          (await db.getStepAttempts(runId)).some((a) =>
            /^stage:\d+:verify:acceptance$/.test(a.stepName),
          ),
        'verify starts',
      )
      third.kill('SIGKILL')
      await third.exited
      await rm(join(gates, 'slow-verify'))
      const fourth = startWorker(box)
      workers.push(fourth)
      await fourth.running()
      await until(
        async () =>
          ['completed', 'failed'].includes(
            (await db.getRun(runId))?.status ?? '',
          ),
        'run finishes',
      )
      const run = await db.getRun(runId)
      assert.equal(run?.status, 'completed', run?.error ?? '')
      // Graded twice on the base (the first cut off), and not again after
      // it completed.
      const baseline = await attempts('baseline')
      assert.equal(baseline.length, 2)
      const report = await buildReport(db, runId)
      assert.equal(report.baseline?.passed, true)
      assert.ok(
        report.baseline?.log?.stdoutPath.includes(baseline[1]?.id ?? '?'),
      )
      fourth.kill('SIGTERM')
      assert.equal(await fourth.exited, 0)
      // A worker that stopped cleanly leaves no note.
      assert.equal(existsSync(join(box.stateRoot, 'worker.json')), false)
    } finally {
      for (const w of workers) {
        w.kill('SIGKILL')
        w.child.kill('SIGKILL')
      }
      await db.db.destroy()
    }
  })

  it('starts while a probe momentarily holds the lock file, but still refuses a live second worker', async () => {
    const box = await sandbox()
    // Create the lock file so a readonly probe connection can open it.
    const created = acquireWorkerLock(box.stateRoot, packageRoot)
    assert.ok(created.acquired)
    if (created.acquired) created.release()
    const lockPath = join(box.stateRoot, 'worker.lock')

    // Simulate `demo wait`'s once-a-second probe holding the lock file open
    // for a moment, spanning the window in which a real worker starts.
    const probe = new Database(lockPath, {
      readonly: true,
      fileMustExist: true,
    })
    probe.exec('BEGIN')
    probe.prepare('SELECT count(*) FROM sqlite_master').get()
    // sleep-ok(work): simulated hold of the lock file; only needs to be well
    // under the worker's retry window, not any particular length
    const release = setTimeout(() => probe.close(), 500)

    const first = startWorker(box)
    try {
      await first.running()
    } finally {
      clearTimeout(release)
      try {
        probe.close()
      } catch {
        // Already closed.
      }
    }

    try {
      // A live second worker is still refused, retry window or not.
      const second = startWorker(box)
      try {
        assert.notEqual(await second.exited, 0)
        assert.match(second.output(), new RegExp(`pid ${first.pid()}\\b`))
      } finally {
        second.kill('SIGKILL')
        second.child.kill('SIGKILL')
      }
    } finally {
      first.kill('SIGKILL')
      first.child.kill('SIGKILL')
    }
  })
})

describe('repair', { timeout: 240000 }, () => {
  it('checks the findings and dispositions files before anything exists', async () => {
    const box = await sandbox({ check: CHECK })
    await writeFile(join(box.root, 'ok.md'), 'a finding\n')
    await writeFile(join(box.root, 'empty.md'), ' \n\t\n')
    await writeFile(join(box.root, 'bad.md'), Buffer.from([0x66, 0xff, 0xfe]))
    await writeFile(join(box.root, 'big.md'), 'x'.repeat(256 * 1024 + 1))
    const refused = async (args: string[], message: RegExp) => {
      const res = await demo(box, ['repair', '--run', 'some-run', ...args])
      assert.notEqual(res.code, 0, args.join(' '))
      assert.match(res.stderr, message)
      assert.equal(existsSync(dbPath(box.stateRoot)), false)
    }
    // Whether findings are required depends on how the parent ended, so a
    // missing file is refused only once the parent is read (see below).
    await refused(['--findings-file', 'gone.md'], /gone\.md: cannot read file/)
    await refused(['--findings-file', 'empty.md'], /empty\.md: file is empty/)
    await refused(['--findings-file', 'bad.md'], /bad\.md: not UTF-8 text/)
    await refused(
      ['--findings-file', 'big.md'],
      /big\.md: file is 262145 bytes; the limit is 256 KiB/,
    )
    await refused(
      ['--findings-file', 'ok.md', '--dispositions-file', 'empty.md'],
      /--dispositions-file empty\.md: file is empty/,
    )
    await writeFile(join(box.root, 'context.md'), 'x'.repeat(32 * 1024 + 1))
    await refused(
      ['--findings-file', 'ok.md', '--context-file', 'context.md'],
      /--context-file context\.md: file is 32769 bytes; the limit is 32 KiB/,
    )
    await refused(
      ['--findings-file', 'ok.md', '--reload-config'],
      /--reload-config is not accepted/,
    )
    // A flag a repair run would ignore is refused, not dropped silently.
    for (const flag of [
      ['--publish'],
      ['--check', 'true'],
      ['--config', 'factory.json'],
      ['--approve', 'manual'],
    ])
      await refused(
        ['--findings-file', 'ok.md', ...flag],
        new RegExp(
          `repair takes only --run, --findings-file, --dispositions-file, --context-file and --max-iterations; not accepted: ${flag[0]}\\.`,
        ),
      )
    await refused(
      ['--findings-file', 'ok.md', '--max-iterations', '0'],
      /--max-iterations must be an integer between 1 and 5/,
    )
  })

  it('takes --max-iterations from 1 to 5 only, and leaves it to the parent when absent', async () => {
    const read = (value?: string) =>
      readRepairFiles({
        run: 'p',
        ...(value !== undefined ? { 'max-iterations': value } : {}),
      })
    assert.equal((await read()).maxIterations, undefined)
    assert.equal('maxIterations' in (await read()), false)
    for (const ok of ['1', '4', '5'])
      assert.equal((await read(ok)).maxIterations, Number(ok))
    for (const bad of [
      '0',
      '6',
      '-1',
      '1.5',
      '4.0',
      'NaN',
      'Infinity',
      '9007199254740993',
      '',
      ' 4',
    ])
      await assert.rejects(
        read(bad),
        /--max-iterations must be an integer between 1 and 5/,
        bad,
      )
  })

  it('refuses every parent that is not an approved, delivered, verification-failed, review-cap-reached or review-incomplete repository run', () => {
    const commit = 'c'.repeat(40)
    const setup = {
      target: { kind: 'repo' },
      profiles: {},
    }
    const good = {
      id: 'p',
      status: 'completed',
      input: { target: { kind: 'repo' } },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    }
    assert.equal(repairableCandidate(good, setup).commit, commit)
    assert.equal(repairableCandidate(good, setup).conclusion, 'approved')
    // A run that stopped on the check needs its candidate, not a delivery.
    const stopped = {
      ...good,
      output: {
        ...good.output,
        approved: false,
        conclusion: 'verification-failed',
        delivery: null as never,
      },
    }
    assert.equal(repairableCandidate(stopped, setup).commit, commit)
    assert.equal(
      repairableCandidate(stopped, setup).conclusion,
      'verification-failed',
    )
    assert.throws(
      () =>
        repairableCandidate(
          {
            ...stopped,
            output: { ...stopped.output, candidate: null as never },
          },
          setup,
        ),
      /no candidate commit/,
    )
    // So does a run that stopped at the review cap (ADR-0030, 2026-10-01).
    const capped = {
      ...stopped,
      output: { ...stopped.output, conclusion: 'review-cap-reached' },
    }
    assert.equal(repairableCandidate(capped, setup).commit, commit)
    assert.equal(
      repairableCandidate(capped, setup).conclusion,
      'review-cap-reached',
    )
    assert.throws(
      () =>
        repairableCandidate(
          {
            ...capped,
            output: {
              ...capped.output,
              candidate: { commit, branch: '' } as never,
            },
          },
          setup,
        ),
      /no candidate commit/,
    )
    const cases: [string, Partial<typeof good>, RegExp][] = [
      ['pending', { status: 'pending' }, /it is pending, not completed/],
      ['leased', { status: 'leased' }, /it is leased, not completed/],
      ['waiting', { status: 'waiting' }, /it is waiting, not completed/],
      [
        'failed',
        { status: 'failed' },
        /it failed for a reason other than a review that did not finish/,
      ],
      ['cancelled', { status: 'cancelled' }, /it is cancelled, not completed/],
      [
        'sample',
        { input: { target: { kind: 'subject' } } },
        /not a repository run/,
      ],
    ]
    // Refused even with a candidate.
    for (const conclusion of ['rejected', 'unknown-conclusion'])
      cases.push([
        conclusion,
        {
          output: {
            ...good.output,
            approved: false,
            conclusion,
            delivery: null as never,
          },
        },
        new RegExp(
          `its conclusion is ${conclusion}, not approved, verification-failed or review-cap-reached`,
        ),
      ])
    for (const status of [
      'pending',
      'leased',
      'waiting',
      'failed',
      'cancelled',
    ])
      cases.push(
        [
          `verification-failed but ${status}`,
          { ...stopped, status },
          status === 'failed'
            ? /it failed for a reason other than a review/
            : new RegExp(`it is ${status}, not completed`),
        ],
        [
          `review-cap-reached but ${status}`,
          { ...capped, status },
          status === 'failed'
            ? /it failed for a reason other than a review/
            : new RegExp(`it is ${status}, not completed`),
        ],
      )
    cases.push(
      [
        'no candidate',
        { output: { ...good.output, candidate: null as never } },
        /no candidate commit/,
      ],
      [
        'no delivery',
        { output: { ...good.output, delivery: null as never } },
        /no delivery/,
      ],
      [
        'delivery mismatch',
        { output: { ...good.output, delivery: { commit: 'd'.repeat(40) } } },
        /delivered commit dddddddddddd is not its last candidate/,
      ],
    )
    for (const [name, change, message] of cases)
      assert.throws(
        () => repairableCandidate({ ...good, ...change }, setup),
        message,
        name,
      )
    assert.throws(() => repairableCandidate(good, null), /setup record/)
  })

  it('repairs a failed repository run only when a review did not finish after its last sealed candidate passed the check', () => {
    const commit = 'c'.repeat(40)
    const setup = { target: { kind: 'repo' }, profiles: {} }
    const step = (name: string, output: unknown, status = 'completed') => ({
      name,
      status,
      output,
      error: null as string | null,
    })
    const sealed = (seq: number, id: string, c = commit) =>
      step(`stage:${seq}:code:candidate`, {
        id,
        commit: c,
        branch: 'factory/p',
      })
    const checked = (seq: number, passed: boolean) =>
      step(`stage:${seq}:verify:acceptance`, { passed, stdout: 'out' })
    const failedReview = step('stage:3:review:edge-cases', null, 'failed')
    failedReview.error = 'review-incomplete (edge-cases): no status line'
    const steps = [
      step('setup', {}),
      sealed(0, 'cand-1', 'a'.repeat(40)),
      checked(1, false),
      sealed(2, 'cand-2'),
      checked(3, true),
      step('stage:3:review:correctness', {
        lens: 'correctness',
        decision: 'needsChanges',
        notes: 'blocker',
      }),
      failedReview,
    ]
    const parent = {
      id: 'p',
      status: 'failed',
      input: { target: { kind: 'repo' } },
      output: null,
      error: 'review-incomplete (edge-cases): no status line',
      steps,
    }
    const got = repairableCandidate(parent, setup)
    assert.equal(got.commit, commit)
    assert.equal(got.branch, 'factory/p')
    assert.equal(got.conclusion, 'review-incomplete')
    // The failed review step's error is enough when the run's says other.
    assert.equal(
      repairableCandidate({ ...parent, error: 'Error: step.all failed' }, setup)
        .conclusion,
      'review-incomplete',
    )
    const refused: [string, Partial<typeof parent>, RegExp][] = [
      [
        'unrelated failure',
        {
          error: 'baseline-check-failed: the check fails on the base',
          steps: steps.filter((s) => s !== failedReview),
        },
        /it failed for a reason other than a review that did not finish/,
      ],
      [
        'no sealed candidate',
        {
          steps: steps.filter((s) => !s.name.endsWith(':code:candidate')),
        },
        /it recorded no sealed candidate with a commit and a branch/,
      ],
      [
        'candidate without a branch',
        {
          steps: steps.map((s) =>
            s.name === 'stage:2:code:candidate'
              ? step(s.name, { id: 'cand-2', commit })
              : s,
          ),
        },
        /no sealed candidate with a commit and a branch/,
      ],
      [
        'no check of the last candidate',
        { steps: steps.filter((s) => s.name !== 'stage:3:verify:acceptance') },
        /no passing check is stored for its last candidate/,
      ],
      [
        'failed check of the last candidate',
        {
          steps: steps.map((s) =>
            s.name === 'stage:3:verify:acceptance' ? checked(3, false) : s,
          ),
        },
        /no passing check is stored for its last candidate/,
      ],
      [
        "an earlier candidate's passing check only",
        {
          steps: [
            sealed(0, 'cand-1', 'a'.repeat(40)),
            checked(1, true),
            sealed(2, 'cand-2'),
            failedReview,
          ],
        },
        /no passing check is stored for its last candidate/,
      ],
      [
        'no stored steps',
        { steps: undefined },
        /it recorded no sealed candidate with a commit and a branch/,
      ],
      [
        'sample',
        { input: { target: { kind: 'subject' } } },
        /not a repository run/,
      ],
    ]
    for (const [name, change, message] of refused)
      assert.throws(
        () => repairableCandidate({ ...parent, ...change }, setup),
        message,
        name,
      )
    assert.throws(() => repairableCandidate(parent, null), /setup record/)
  })

  it("builds a review-incomplete parent's findings from its last candidate's finished needsChanges reviews only", () => {
    const commit = 'c'.repeat(40)
    const step = (name: string, output: unknown, status = 'completed') => ({
      name,
      status,
      output,
      error: null as string | null,
    })
    const review = (
      seq: number,
      lens: string,
      decision: string,
      notes: string,
    ) => step(`stage:${seq}:review:${lens}`, { lens, decision, notes })
    const parent = (last: ReturnType<typeof step>[]) => ({
      id: 'p',
      status: 'failed',
      input: { target: { kind: 'repo' } },
      output: null,
      error: 'review-incomplete (edge-cases): 0 findings',
      steps: [
        step('stage:0:code:candidate', {
          id: 'cand-1',
          commit: 'a'.repeat(40),
          branch: 'factory/p',
        }),
        step('stage:1:verify:acceptance', { passed: true }),
        // An earlier candidate's review: never part of the findings.
        review(1, 'correctness', 'needsChanges', 'EARLIER NOTE'),
        review(1, 'edge-cases', 'needsChanges', 'EARLIER EDGE'),
        step('stage:2:code:candidate', {
          id: 'cand-2',
          commit,
          branch: 'factory/p',
        }),
        step('stage:3:verify:acceptance', { passed: true }),
        ...last,
      ],
    })
    const both = parent([
      review(3, 'correctness', 'needsChanges', 'refunds truncate\nline two'),
      step('stage:3:review:edge-cases', null, 'failed'),
    ])
    const built = incompleteReviewFindings(both)
    assert.deepEqual(built.ref, { parentRun: 'p' })
    assert.match(built.content, /^# Review findings of factory run p$/m)
    assert.match(built.content, new RegExp(`commit ${commit}`))
    assert.match(
      built.content,
      /^## correctness\n\nrefunds truncate\nline two$/m,
    )
    assert.doesNotMatch(built.content, /EARLIER|## edge-cases/)
    assert.deepEqual(incompleteReviewFindings(both), built)
    // A pass, a blank note and a cancelled review add nothing.
    const one = incompleteReviewFindings(
      parent([
        review(3, 'correctness', 'pass', 'PASS NOTE'),
        review(3, 'edge-cases', 'needsChanges', 'empty cart'),
      ]),
    ).content
    assert.doesNotMatch(one, /PASS NOTE|## correctness|EARLIER/)
    assert.match(one, /^## edge-cases\n\nempty cart$/m)
    for (const [name, last] of [
      [
        'a pass and a failed review',
        [
          review(3, 'correctness', 'pass', 'fine'),
          step('stage:3:review:edge-cases', null, 'failed'),
        ],
      ],
      ['blank notes', [review(3, 'correctness', 'needsChanges', '  \n\t')]],
      [
        'a cancelled review',
        [
          step('stage:3:review:correctness', {
            lens: 'correctness',
            status: 'cancelled',
            reason: 'superseded-by-verify',
          }),
        ],
      ],
      ['no review of the last candidate', []],
    ] as const)
      assert.throws(
        () => incompleteReviewFindings(parent([...last])),
        /refusing to repair p: no stored review asked for changes with notes; give the findings with --findings-file <path> instead/,
        name,
      )
  })

  it('names repair for a failed repository run only when its last candidate passed the check and a review did not finish', async () => {
    const commit = 'c'.repeat(40)
    const steps = [
      {
        name: 'stage:0:code:candidate',
        status: 'completed',
        output: { id: 'cand-1', commit, branch: 'factory/r1' },
        error: null,
      },
      {
        name: 'stage:1:verify:acceptance',
        status: 'completed',
        output: { passed: true },
        error: null,
      },
    ]
    const classify = (
      run: { status?: string; error?: string; kind?: string },
      stored = steps,
    ) =>
      classifyRun(
        {
          getStepAttempts: async () => [],
          storage: {
            getCompletedStep: async () => null,
            getSteps: async () => stored as never,
          },
        },
        {
          id: 'r1',
          status: (run.status ?? 'failed') as never,
          input: { target: { kind: run.kind ?? 'repo' } },
          output: null,
          error: run.error ?? 'review-incomplete (edge-cases): no status line',
        },
      )
    const repair = (lines: string[] | undefined) =>
      (lines ?? []).filter((l) => l.includes(' repair --run r1 '))
    const eligible = await classify({})
    assert.equal(repair(eligible?.next).length, 1)
    assert.match(
      repair(eligible?.next)[0] ?? '',
      /unless --findings-file is given$/,
    )
    for (const [name, failure] of [
      ['unrelated error', classify({ error: 'something else broke' })],
      ['sample run', classify({ kind: 'subject' })],
      [
        'failed check',
        classify({}, [
          steps[0] as (typeof steps)[number],
          {
            ...(steps[1] as (typeof steps)[number]),
            output: { passed: false },
          },
        ]),
      ],
      ['no candidate', classify({}, [])],
    ] as const)
      assert.deepEqual(repair((await failure)?.next), [], name)
  })

  it('tells the repairer and both reviewers that a review-incomplete base passed the check but was never fully reviewed', () => {
    const code = codePrompt({
      role: 'repair',
      iteration: 1,
      repairNotes: [],
      task: 'TASK',
      rules: [],
      fromFindings: 'review-incomplete',
    })
    assert.match(
      code,
      /never approved: the pinned check passed on it, but that run failed because its reviews did not finish, so no reviewer has judged the whole candidate/,
    )
    for (const lens of ['correctness', 'edge-cases'] as const) {
      const prompt = reviewPrompt(
        lens,
        'TRUSTED CONTEXT',
        [],
        [],
        null,
        'review-incomplete',
      )
      assert.match(
        prompt,
        /the pinned check passed on it, but its reviews did not finish, so no reviewer has judged it as a whole/,
      )
      assert.match(
        prompt,
        /judge the candidate as a whole, base and repair together/,
      )
    }
  })

  it('names repair beside retrigger for a verification-failed or review-cap-reached repository run only', () => {
    const next = (conclusion: string, repo: boolean | undefined) =>
      classifyFailure({
        runId: 'r1',
        status: 'completed',
        output: { conclusion },
        error: null,
        uncertain: [],
        ...(repo === undefined ? {} : { repo }),
      })?.next ?? []
    const repair = (lines: string[]) =>
      lines.filter((l) => l.includes(' repair --run r1 '))
    for (const [conclusion, source] of [
      ['verification-failed', 'check failure'],
      ['review-cap-reached', 'last reviews'],
    ] as const) {
      const lines = next(conclusion, true)
      assert.equal(repair(lines).length, 1, conclusion)
      assert.match(
        repair(lines)[0] ?? '',
        new RegExp(`built from the ${source} unless --findings-file is given$`),
      )
      assert.ok(lines.some((l) => l.includes(' retrigger --run r1 ')))
      assert.deepEqual(repair(next(conclusion, false)), [], conclusion)
    }
  })

  it("builds findings from the parent's last needsChanges reviews only, the same every time", () => {
    const commit = 'c'.repeat(40)
    const parent = (reviews: unknown) => ({
      id: 'p',
      status: 'completed',
      input: { target: { kind: 'repo' } },
      output: {
        approved: false,
        conclusion: 'review-cap-reached',
        candidate: { id: 'cand-2', commit, branch: 'factory/p' },
        delivery: null,
        reviews,
      },
    })
    const both = parent([
      {
        lens: 'correctness',
        decision: 'needsChanges',
        notes: 'refunds still truncate\nsecond line',
      },
      { lens: 'edge-cases', decision: 'needsChanges', notes: 'empty cart' },
    ])
    const built = reviewFindings(both)
    assert.deepEqual(built.ref, { parentRun: 'p' })
    assert.match(built.content, /^# Review findings of factory run p$/m)
    assert.match(built.content, new RegExp(`commit ${commit}`))
    assert.match(
      built.content,
      /^## correctness\n\nrefunds still truncate\nsecond line\n\n## edge-cases\n\nempty cart$/m,
    )
    assert.deepEqual(reviewFindings(both), built)
    // A pass review's notes, and a review with blank notes, are left out.
    const one = reviewFindings(
      parent([
        { lens: 'correctness', decision: 'pass', notes: 'PASS NOTE' },
        { lens: 'edge-cases', decision: 'needsChanges', notes: 'empty cart' },
      ]),
    ).content
    assert.doesNotMatch(one, /PASS NOTE|## correctness/)
    assert.match(one, /^## edge-cases\n\nempty cart$/m)
    const refused = (reviews: unknown, name: string) =>
      assert.throws(
        () => reviewFindings(parent(reviews)),
        /refusing to repair p: no stored review asked for changes with notes; give the findings with --findings-file <path> instead/,
        name,
      )
    refused(
      [
        { lens: 'correctness', decision: 'pass', notes: 'fine' },
        { lens: 'edge-cases', decision: 'pass', notes: 'fine' },
      ],
      'all pass',
    )
    refused(
      [
        { lens: 'correctness', decision: 'needsChanges', notes: '  \n\t' },
        { lens: 'edge-cases', decision: 'pass', notes: 'fine' },
      ],
      'blank notes',
    )
    refused([], 'no reviews')
    refused(undefined, 'reviews missing')
  })

  it("builds findings from the last candidate's failed check only, the same every time", () => {
    const commit = 'c'.repeat(40)
    const parent = {
      id: 'p',
      status: 'completed',
      input: { target: { kind: 'repo' } },
      output: {
        approved: false,
        conclusion: 'verification-failed',
        candidate: { id: 'cand-2', commit, branch: 'factory/p' },
        delivery: null,
      },
    }
    const step = (name: string, output: unknown, status = 'completed') => ({
      name,
      status,
      output,
    })
    const failed = (stdout: string, exitCode: number | null = 1) => ({
      passed: false,
      stdout,
      exitCode,
      log: { stdoutPath: '/gone/stdout.log', stderrPath: '/gone/stderr.log' },
    })
    const first = [
      step('setup', {}),
      step('stage:1:code:candidate', { id: 'cand-1', commit: 'a'.repeat(40) }),
      step('stage:2:verify:acceptance', failed('EARLIER FAILURE\n')),
      step('stage:3:code:candidate', { id: 'cand-2', commit }),
    ]
    const check = ['node', '--test', 'test/**/*.test.js']
    // Sequential: the check of the last candidate is the next verify step.
    const sequential = [
      ...first,
      step(
        'stage:4:verify:acceptance',
        failed('not ok 1 - adds ``` decimals\n'),
      ),
    ]
    const built = checkFailureFindings(parent, sequential, check)
    assert.deepEqual(built.ref, { parentRun: 'p' })
    assert.match(built.content, /^# Check failure of factory run p$/m)
    assert.match(built.content, new RegExp(`commit ${commit}`))
    assert.ok(
      built.content.includes(`- check command: ${JSON.stringify(check)}`),
    )
    assert.match(built.content, /^- exit code: 1$/m)
    assert.ok(built.content.includes('not ok 1 - adds ``` decimals'))
    // A fence longer than any backtick run in the output.
    assert.match(built.content, /^````$/m)
    assert.doesNotMatch(built.content, /EARLIER FAILURE|\/gone\//)
    assert.deepEqual(checkFailureFindings(parent, sequential, check), built)
    // Parallel verification and review (ADR-0029) name the check the same
    // way, beside review steps of the same sequence.
    const parallel = [
      ...first,
      step('stage:4:review:correctness', {
        lens: 'correctness',
        status: 'cancelled',
      }),
      step(
        'stage:4:verify:acceptance',
        failed('not ok 1 - adds ``` decimals\n'),
      ),
    ]
    assert.equal(
      checkFailureFindings(parent, parallel, check).content,
      built.content,
    )
    const refused = (steps: typeof first, message: RegExp, name: string) =>
      assert.throws(
        () => checkFailureFindings(parent, steps, check),
        (error: Error) =>
          message.test(error.message) &&
          /--findings-file <path> instead/.test(error.message),
        name,
      )
    // Missing: an earlier candidate's failure is never used instead.
    refused(
      first,
      /no failed check output is stored for its last candidate/,
      'missing',
    )
    refused(
      [...first, step('stage:4:verify:acceptance', failed('x'), 'failed')],
      /no failed check output/,
      'not completed',
    )
    refused(
      [...first, step('stage:4:verify:acceptance', failed('  \n'))],
      /no failed check output/,
      'blank output',
    )
    refused(
      [
        ...first,
        step('stage:4:verify:acceptance', {
          passed: true,
          stdout: 'ok',
          exitCode: 0,
        }),
      ],
      /no failed check output/,
      'passed',
    )
    refused(
      [
        ...first,
        step('stage:4:verify:acceptance', { passed: false, exitCode: 1 }),
      ],
      /no failed check output/,
      'no output',
    )
    refused(
      first.slice(0, 3),
      /its last candidate has no stored sealing step/,
      'candidate not sealed',
    )
  })

  it('inherits a null or false the parent setup recorded, and falls back only when the setup lacks the value', () => {
    const commit = 'c'.repeat(40)
    const profile = (role: string) => ({
      id: `fake:provider-default:provider-default:${role}`,
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
    })
    const storedCommit = {
      authorName: 'Stored',
      authorEmail: 'stored@example.com',
      messageTemplate: null,
    }
    const parent = {
      id: 'p',
      status: 'completed',
      input: {
        provider: 'fake',
        codexPath: '/stored/codex',
        target: {
          kind: 'repo',
          baselineCheck: true,
          baselineReuse: { maxAgeMs: 7000 },
          commit: storedCommit,
        },
      },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    }
    const setup = {
      contextMode: 'reuse',
      maxIterations: 1,
      agentTimeoutMs: 600000,
      autoApprove: true,
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
      },
      repair: null,
      triage: profile('triage'),
      codexPath: null,
      baselineCheck: false,
      baselineReuse: null,
      target: {
        kind: 'repo',
        repoPath: '/repo',
        task: 'task',
        spec: null,
        dispositions: null,
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        checkTimeoutMs: 120000,
        publish: false,
        commit: { authorName: null, authorEmail: null, messageTemplate: null },
      },
    }
    const files = {
      findings: { content: 'FINDING\n', ref: { path: '/f.md' } },
      dispositions: null,
    }
    const { input } = buildRepairInput(parent, setup, files)
    assert.equal(input.codexPath, null)
    assert.equal(input.target.baselineCheck, false)
    assert.equal(input.target.baselineReuse, null)
    // The parent's reuse setting as its setup recorded it.
    assert.deepEqual(
      buildRepairInput(
        parent,
        { ...setup, baselineCheck: true, baselineReuse: { maxAgeMs: 5000 } },
        files,
      ).input.target.baselineReuse,
      { maxAgeMs: 5000 },
    )
    assert.deepEqual(input.target.commit, setup.target.commit)
    assert.deepEqual(input.repairOf.profiles.triage, setup.triage)
    // A setup from before a value existed takes it from the stored input.
    const {
      codexPath: _c,
      baselineCheck: _b,
      baselineReuse: _r,
      triage: _t,
      ...older
    } = setup
    const { commit: _m, ...olderTarget } = setup.target
    const fallback = buildRepairInput(
      parent,
      { ...older, target: olderTarget },
      files,
    ).input
    assert.equal(fallback.codexPath, '/stored/codex')
    assert.equal(fallback.target.baselineCheck, true)
    assert.deepEqual(fallback.target.baselineReuse, { maxAgeMs: 7000 })
    assert.deepEqual(fallback.target.commit, storedCommit)
    assert.equal(fallback.repairOf.profiles.triage, null)
  })

  it('starts one child per findings and dispositions content, with the parent settings', async () => {
    const box = await sandbox({
      check: CHECK,
      checkTimeoutMs: 150000,
      agentTimeoutMs: 700000,
      agentIdleTimeoutMs: 500000,
    })
    const parentId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the parent task',
      '--max-iterations',
      '1',
    ])
    process.env.FAKE_FAIL_FIRST = '0'
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    try {
      await until(
        async () => (await durably.getRun(parentId))?.status === 'completed',
        'the parent completes',
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
    const parent = await inputOf(box, parentId)
    // Neither the config nor the environment decides anything now.
    await writeFile(
      join(box.repo, 'factory.json'),
      JSON.stringify({ check: ['false'], agentTimeoutMs: 1000 }),
    )
    const env = {
      AGENT_TIMEOUT_MS: '5555',
      AGENT_IDLE_TIMEOUT_MS: '5555',
      TEST_TIMEOUT_MS: '5555',
    }
    await mkdir(join(box.root, 'a'))
    await mkdir(join(box.root, 'b'))
    await writeFile(join(box.root, 'a', 'findings.md'), 'FINDING: refunds\n')
    await writeFile(join(box.root, 'b', 'copy.md'), 'FINDING: refunds\n')
    await writeFile(join(box.root, 'disp.md'), 'CHILD DISPOSITIONS\n')
    const repair = async (args: string[]) => {
      const res = await demo(box, ['repair', '--run', parentId, ...args], env)
      assert.equal(res.code, 0, res.stderr)
      return JSON.parse(res.stdout) as {
        runId: string
        disposition: string
        parentRunId: string
        branch: string
      }
    }
    // An approved parent needs findings from outside.
    const bare = await demo(box, ['repair', '--run', parentId], env)
    assert.notEqual(bare.code, 0)
    assert.match(
      bare.stderr,
      /it was approved, so --findings-file <path> is required/,
    )
    const first = await repair(['--findings-file', 'a/findings.md'])
    assert.equal(first.disposition, 'created')
    assert.equal(first.parentRunId, parentId)
    assert.equal(first.branch, `factory/${first.runId}`)
    const again = await repair(['--findings-file', 'b/copy.md'])
    assert.equal(again.runId, first.runId)
    assert.equal(again.disposition, 'idempotent')
    const other = await repair([
      '--findings-file',
      'a/findings.md',
      '--dispositions-file',
      'disp.md',
    ])
    assert.notEqual(other.runId, first.runId)
    // The parent's budget, given, is the inherited one; another is another
    // child, returned again for the same budget.
    const sameBudget = await repair([
      '--findings-file',
      'a/findings.md',
      '--max-iterations',
      '1',
    ])
    assert.equal(sameBudget.runId, first.runId)
    assert.equal(sameBudget.disposition, 'idempotent')
    const budget = await repair([
      '--findings-file',
      'a/findings.md',
      '--max-iterations',
      '4',
    ])
    assert.equal(budget.disposition, 'created')
    assert.notEqual(budget.runId, first.runId)
    const budgetAgain = await repair([
      '--findings-file',
      'b/copy.md',
      '--max-iterations',
      '4',
    ])
    assert.equal(budgetAgain.runId, budget.runId)
    assert.equal(budgetAgain.disposition, 'idempotent')

    type ChildInput = RunInput & {
      maxIterations: number
      repairOf: {
        runId: string
        findings: string
        findingsFile: { path: string }
      }
    }
    const child = (await inputOf(box, first.runId)) as ChildInput
    assert.equal(child.repairOf.runId, parentId)
    assert.equal(child.repairOf.findings, 'FINDING: refunds\n')
    assert.ok(
      child.repairOf.findingsFile.path.endsWith(join('a', 'findings.md')),
    )
    assert.equal(child.target.task, parent.target.task)
    assert.equal(child.target.spec, parent.target.spec)
    assert.deepEqual(child.target.checkCommand, CHECK)
    assert.equal(child.checkTimeoutMs, 150000)
    assert.equal(child.agentTimeoutMs, 700000)
    // The parent's idle limit as it was fixed, never read again.
    assert.equal(child.agentIdleTimeoutMs, 500000)
    assert.equal(child.codexPath, parent.codexPath ?? null)
    assert.equal(child.maxIterations, 1)
    assert.equal(child.target.dispositions, null)
    assert.equal('configSource' in child, false)
    const withDisp = (await inputOf(box, other.runId)) as ChildInput
    assert.equal(withDisp.target.dispositions, 'CHILD DISPOSITIONS\n')
    const withBudget = (await inputOf(box, budget.runId)) as ChildInput
    assert.equal(withBudget.maxIterations, 4)
    assert.equal(withBudget.checkTimeoutMs, 150000)

    // status --run shows both sides.
    const parentStatus = await demo(box, ['status', '--run', parentId])
    assert.deepEqual(
      (JSON.parse(parentStatus.stdout) as { lineage: unknown }).lineage,
      { parent: null, children: [first.runId, other.runId, budget.runId] },
    )
    const childStatus = await demo(box, ['status', '--run', first.runId])
    assert.equal(
      (JSON.parse(childStatus.stdout) as { lineage: { parent: string } })
        .lineage.parent,
      parentId,
    )

    // A candidate branch moved since approval starts nothing.
    const output = (await (async () => {
      const d = createAgentDurably({ stateRoot: box.stateRoot })
      try {
        await d.migrate()
        return (await d.getRun(parentId))?.output
      } finally {
        await d.db.destroy()
      }
    })()) as { candidate: { branch: string } }
    await git(box.repo, [
      'update-ref',
      `refs/heads/${output.candidate.branch}`,
      'main',
    ])
    await writeFile(join(box.root, 'new.md'), 'FINDING: new\n')
    const moved = await demo(
      box,
      ['repair', '--run', parentId, '--findings-file', 'new.md'],
      env,
    )
    assert.notEqual(moved.code, 0)
    assert.match(moved.stderr, /candidate branch .* moved to/)
    const d = createAgentDurably({ stateRoot: box.stateRoot })
    try {
      await d.migrate()
      const children = (await d.getRuns()).filter(
        (r) =>
          (r.input as { repairOf?: { runId?: string } }).repairOf?.runId ===
          parentId,
      )
      assert.equal(children.length, 3)
    } finally {
      await d.db.destroy()
    }
    // A stopped child's settings stay its parent's: no config reload.
    await assert.rejects(
      reloadTriggerInput(
        child as unknown as Parameters<typeof reloadTriggerInput>[0],
      ),
      /does not apply to a repair run/,
    )
  })

  it('repairs a verification-failed parent from its stored check failure, or from a file given instead', async () => {
    const box = await sandbox({ check: CHECK })
    // The fake leaves the bug in its one iteration: the check fails.
    delete process.env.FAKE_FAIL_FIRST
    const parentId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the parent task',
      '--max-iterations',
      '1',
    ])
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    let stored: { stdout: string; exitCode: number | null }
    try {
      await until(
        async () => (await durably.getRun(parentId))?.status === 'completed',
        'the parent stops',
      )
      const output = (await durably.getRun(parentId))?.output as {
        conclusion: string
      }
      assert.equal(output.conclusion, 'verification-failed')
      const step = (await durably.storage.getSteps(parentId)).find((s) =>
        /^stage:\d+:verify:acceptance$/.test(s.name),
      )
      stored = step?.output as typeof stored
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
    await writeFile(join(box.root, 'findings.md'), 'FINDING: by hand\n')
    await writeFile(join(box.root, 'disp.md'), 'CHILD DISPOSITIONS\n')
    const repair = async (args: string[]) => {
      const res = await demo(box, ['repair', '--run', parentId, ...args])
      assert.equal(res.code, 0, res.stderr)
      return JSON.parse(res.stdout) as {
        runId: string
        disposition: string
        parentRunId: string
      }
    }
    const derived = await repair([])
    assert.equal(derived.disposition, 'created')
    assert.equal(derived.parentRunId, parentId)
    // The same parent and dispositions return the same child.
    const again = await repair([])
    assert.equal(again.runId, derived.runId)
    assert.equal(again.disposition, 'idempotent')
    const withDisp = await repair(['--dispositions-file', 'disp.md'])
    assert.notEqual(withDisp.runId, derived.runId)
    // A file given for such a parent takes precedence.
    const fromFile = await repair(['--findings-file', 'findings.md'])
    assert.notEqual(fromFile.runId, derived.runId)

    type ChildInput = RunInput & {
      maxIterations: number
      repairOf: {
        runId: string
        parentConclusion: string
        findings: string
        findingsFile: { path?: string; parentRun?: string }
      }
    }
    const child = (await inputOf(box, derived.runId)) as ChildInput
    assert.equal(child.repairOf.parentConclusion, 'verification-failed')
    assert.deepEqual(child.repairOf.findingsFile, { parentRun: parentId })
    assert.ok(child.repairOf.findings.includes(stored.stdout.trimEnd()))
    assert.match(child.repairOf.findings, /^- exit code: 1$/m)
    assert.ok(
      child.repairOf.findings.includes(
        `- check command: ${JSON.stringify(CHECK)}`,
      ),
    )
    assert.equal(stored.exitCode, 1)
    assert.equal(child.maxIterations, 1)
    const byHand = (await inputOf(box, fromFile.runId)) as ChildInput
    assert.equal(byHand.repairOf.findings, 'FINDING: by hand\n')
    assert.ok(byHand.repairOf.findingsFile.path?.endsWith('findings.md'))
    assert.equal(byHand.repairOf.parentConclusion, 'verification-failed')

    // status --run links the children to the parent by repair lineage.
    const parentStatus = await demo(box, ['status', '--run', parentId])
    assert.deepEqual(
      (
        JSON.parse(parentStatus.stdout) as { lineage: { children: string[] } }
      ).lineage.children.sort(),
      [derived.runId, withDisp.runId, fromFile.runId].sort(),
    )
  })

  it('repairs a review-cap-reached parent from its stored reviews, or from a file given instead', async () => {
    const box = await sandbox({ check: CHECK })
    // The check passes; one reviewer still asks for changes after the one
    // iteration.
    process.env.FAKE_FAIL_FIRST = '0'
    process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
    const parentId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'the parent task',
      '--max-iterations',
      '1',
    ])
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.init()
    let reviews: { lens: string; decision: string; notes: string }[]
    try {
      await until(
        async () => (await durably.getRun(parentId))?.status === 'completed',
        'the parent stops',
      )
      const output = (await durably.getRun(parentId))?.output as {
        conclusion: string
        reviews: typeof reviews
      }
      assert.equal(output.conclusion, 'review-cap-reached')
      reviews = output.reviews
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_REVIEW_SEQUENCE
    }
    const blocking = reviews.filter((r) => r.decision === 'needsChanges')
    const passing = reviews.filter((r) => r.decision === 'pass')
    assert.equal(blocking.length, 1)
    assert.equal(passing.length, 1)
    await writeFile(join(box.root, 'findings.md'), 'FINDING: by hand\n')
    const repair = async (args: string[]) => {
      const res = await demo(box, ['repair', '--run', parentId, ...args])
      assert.equal(res.code, 0, res.stderr)
      return JSON.parse(res.stdout) as { runId: string; disposition: string }
    }
    const derived = await repair([])
    assert.equal(derived.disposition, 'created')
    assert.equal((await repair([])).runId, derived.runId)
    const fromFile = await repair(['--findings-file', 'findings.md'])
    assert.notEqual(fromFile.runId, derived.runId)
    const fourTimes = await repair(['--max-iterations', '4'])
    assert.notEqual(fourTimes.runId, derived.runId)

    type ChildInput = RunInput & {
      maxIterations: number
      repairOf: {
        parentConclusion: string
        findings: string
        findingsFile: { path?: string; parentRun?: string }
      }
    }
    const child = (await inputOf(box, derived.runId)) as ChildInput
    assert.equal(child.repairOf.parentConclusion, 'review-cap-reached')
    assert.deepEqual(child.repairOf.findingsFile, { parentRun: parentId })
    assert.ok(child.repairOf.findings.includes(`## ${blocking[0]?.lens}`))
    assert.ok(child.repairOf.findings.includes(blocking[0]?.notes ?? '-'))
    assert.ok(!child.repairOf.findings.includes(passing[0]?.notes ?? '-'))
    assert.equal(child.maxIterations, 1)
    const byHand = (await inputOf(box, fromFile.runId)) as ChildInput
    assert.equal(byHand.repairOf.findings, 'FINDING: by hand\n')
    assert.equal(byHand.repairOf.parentConclusion, 'review-cap-reached')
    const budget = (await inputOf(box, fourTimes.runId)) as ChildInput
    assert.equal(budget.maxIterations, 4)
    assert.equal(budget.repairOf.findings, child.repairOf.findings)
  })
})

describe('reviewer command, context and output', { timeout: 120000 }, () => {
  type Config = Parameters<typeof resolveProfiles>[1]
  const review = (
    provider: string,
    correctness: Record<string, unknown>,
    edgeCases: Record<string, unknown> = {},
  ) =>
    resolveProfiles({ provider }, {
      profiles: { review: { correctness, 'edge-cases': edgeCases } },
    } as Config).review

  it('fixes each lens on its own, defaults filled in, and leaves an unnamed lens out', () => {
    assert.deepEqual(
      review('fake', {
        command: '/code-review {base}..{head} {effort}',
        context: 'local-instructions',
      }),
      {
        correctness: {
          command: '/code-review {base}..{head} {effort}',
          context: 'local-instructions',
          output: 'verdict',
        },
      },
    )
    assert.deepEqual(review('fake', {}, { output: 'findings-json' }), {
      'edge-cases': {
        command: null,
        context: 'prompt',
        output: 'findings-json',
      },
    })
    // The findings contract does not depend on the provider.
    for (const provider of ['codex', 'claude'])
      assert.deepEqual(review(provider, { output: 'findings-json' }), {
        correctness: {
          command: null,
          context: 'prompt',
          output: 'findings-json',
        },
      })
    assert.deepEqual(
      review('claude', { command: '/code-review', model: 'claude-opus-5-5' }),
      {
        correctness: {
          command: '/code-review',
          context: 'prompt',
          output: 'verdict',
        },
      },
    )
  })

  it('refuses a codex reviewer with a command or local instructions, naming the role and the fields', () => {
    assert.throws(
      () => review('codex', { command: '/review' }),
      /profiles\.review\.correctness: a codex reviewer does not support command;/,
    )
    assert.throws(
      () => review('codex', {}, { context: 'local-instructions' }),
      /profiles\.review\.edge-cases: a codex reviewer does not support context: local-instructions;/,
    )
    assert.throws(
      () =>
        review(
          'claude',
          {},
          {
            provider: 'codex',
            command: '/review',
            context: 'local-instructions',
          },
        ),
      /edge-cases: a codex reviewer does not support command or context: local-instructions/,
    )
  })

  it('refuses unknown or unresolvable placeholders and a blank command', () => {
    for (const [command, error] of [
      [
        '/review {model}',
        /correctness: command: unknown placeholder \{model\}/,
      ],
      ['/review {base', /correctness: command: unclosed "\{"/],
      ['/review base}', /correctness: command: unmatched "\}"/],
      ['   ', /correctness: command must not be empty/],
    ] as const)
      assert.throws(() => review('fake', { command }), error, command)
    // A model with no preset resolves no effort, so {effort} has no value.
    assert.throws(
      () =>
        review('claude', { command: '/r {effort}', model: 'claude-unlisted' }),
      /correctness: command uses \{effort\}, but the role resolves no effort/,
    )
    assert.deepEqual(
      review('claude', {
        command: '/r {effort}',
        model: 'claude-unlisted',
        effort: 'high',
      }),
      {
        correctness: {
          command: '/r {effort}',
          context: 'prompt',
          output: 'verdict',
        },
      },
    )
  })

  it('refuses a bad setting at trigger before the run exists, and stores a good one', async () => {
    for (const [provider, correctness, message] of [
      ['fake', { command: '  ' }, /invalid factory config[\s\S]*command/],
      ['fake', { context: 'file' }, /invalid factory config[\s\S]*context/],
      ['fake', { output: 'json' }, /invalid factory config[\s\S]*output/],
      ['fake', { command: '/r {model}' }, /unknown placeholder \{model\}/],
      [
        'codex',
        { command: '/review' },
        /profiles\.review\.correctness: a codex reviewer does not support command/,
      ],
    ] as const) {
      const box = await sandbox({
        check: CHECK,
        profiles: { review: { correctness } },
      })
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x', '--provider', provider],
        message,
      )
    }
    const box = await sandbox({
      check: CHECK,
      profiles: {
        review: {
          correctness: {
            command: '/code-review {head}',
            context: 'local-instructions',
          },
        },
      },
    })
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'x'])
    const input = (await inputOf(box, runId)) as RunInput & {
      review?: unknown
    }
    assert.deepEqual(input.review, {
      correctness: {
        command: '/code-review {head}',
        context: 'local-instructions',
        output: 'verdict',
      },
    })
  })
})

describe('wait and worker state', { timeout: 300000 }, () => {
  interface WaitSummary {
    runId: string
    status: string
    exitCode: number
    conclusion: string | null
    stopReason: string
    next: string[]
    worker: {
      running: boolean | null
      pid: number | null
      start: string | null
    }
    lastLeaseRenewedAt: string | null
    stageTimings: {
      stage: string
      elapsedMs: number | null
      complete: boolean
    }[]
    stageTotalMs: number | null
    runElapsedMs: number | null
  }

  async function waitJson(box: Sandbox, runId: string, flags: string[] = []) {
    const res = await demo(box, [
      'wait',
      '--run',
      runId,
      '--format',
      'json',
      ...flags,
    ])
    return { code: res.code, out: JSON.parse(res.stdout) as WaitSummary }
  }

  async function statusJson(box: Sandbox, runId: string) {
    const res = await demo(box, ['status', '--run', runId])
    assert.equal(res.code, 0, res.stderr)
    return JSON.parse(res.stdout) as {
      worker: {
        running: boolean | null
        pid: number | null
        start: string | null
      }
      lastLeaseRenewedAt: string | null
      diagnosis: { next: string[] }
    }
  }

  it('refuses a bad timeout, or an unknown run, before waiting', async () => {
    const box = await sandbox()
    const bad = ['0', '-1', '1.5', 'NaN', 'Infinity', '2147483648', 'soon']
    for (const flag of ['--timeout', '--worker-timeout'])
      for (const value of bad) {
        const res = await demo(box, ['wait', '--run', 'x', flag, value])
        assert.equal(res.code, 1, `${flag} ${value}`)
        assert.match(res.stderr, /must be an integer number of milliseconds/)
      }
    const both = await demo(box, [
      'wait',
      '--run',
      'x',
      '--worker-timeout',
      '5',
      '--no-worker-timeout',
    ])
    assert.equal(both.code, 1)
    // Nothing was opened, so nothing was waited on.
    assert.equal(existsSync(dbPath(box.stateRoot)), false)
    const unknown = await demo(box, ['wait', '--run', 'no-such-run'])
    assert.equal(unknown.code, 1)
    assert.match(unknown.stderr, /no run no-such-run/)
  })

  it('reads the worker from its lock, gives a lease time only for a live lease, and gives up without a worker', async () => {
    const box = await sandbox()
    // A note from a worker that is gone, naming a live pid: not a worker.
    await mkdir(box.stateRoot, { recursive: true })
    await writeFile(
      join(box.stateRoot, 'worker.json'),
      JSON.stringify({
        pid: process.pid,
        checkout: packageRoot,
        startedAt: new Date().toISOString(),
      }),
    )
    const triggered = await demo(box, ['trigger', '--provider', 'fake'])
    assert.equal(triggered.code, 0, triggered.stderr)
    const shown = JSON.parse(triggered.stdout) as {
      runId: string
      worker: { running: boolean; pid: number | null; start: string | null }
    }
    const runId = shown.runId
    assert.equal(shown.worker.running, false)
    assert.equal(shown.worker.pid, null)
    assert.match(shown.worker.start ?? '', /demo worker$/)
    const list = await demo(box, ['status'])
    assert.match(
      list.stdout,
      /worker: not running; start one with .*demo worker/,
    )
    assert.match(blockOf(list.stdout, runId), /demo worker/)
    const absent = await statusJson(box, runId)
    assert.equal(absent.worker.running, false)
    assert.equal(absent.lastLeaseRenewedAt, null)

    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.migrate()
    const lock = acquireWorkerLock(box.stateRoot, packageRoot)
    assert.ok(lock.acquired)
    try {
      const again = await demo(box, ['trigger', '--provider', 'fake'])
      const up = JSON.parse(again.stdout) as {
        worker: { running: boolean; pid: number | null; start: string | null }
      }
      assert.deepEqual(
        {
          running: up.worker.running,
          pid: up.worker.pid,
          start: up.worker.start,
        },
        { running: true, pid: process.pid, start: null },
      )
      // A worker is up but the run holds no lease: no renewal to show, and
      // no worker to start.
      const idle = await statusJson(box, runId)
      assert.equal(idle.worker.running, true)
      assert.equal(idle.lastLeaseRenewedAt, null)
      assert.ok(!idle.diagnosis.next.some((n) => /demo worker/.test(n)))

      const setRun = (values: Record<string, string | null>) =>
        durably.db
          .updateTable('durably_runs')
          .set(values)
          .where('id', '=', runId)
          .execute()
      const expires = new Date(Date.now() + 5000).toISOString()
      await setRun({
        status: 'leased',
        lease_owner: 'other-worker',
        lease_expires_at: expires,
      })
      assert.equal(
        (await statusJson(box, runId)).lastLeaseRenewedAt,
        new Date(Date.parse(expires) - 10000).toISOString(),
      )
      await setRun({
        lease_expires_at: new Date(Date.now() - 60000).toISOString(),
      })
      assert.equal((await statusJson(box, runId)).lastLeaseRenewedAt, null)

      // A `status` inside the output or progress is not the run's.
      await setRun({
        status: 'pending',
        lease_owner: null,
        lease_expires_at: null,
        output: JSON.stringify({ status: 'completed' }),
        progress: JSON.stringify({ current: 0, status: 'waiting' }),
      })
      const held = await waitJson(box, runId, ['--timeout', '1500'])
      assert.equal(held.code, 5)
      assert.equal(held.out.exitCode, 5)
      assert.equal(held.out.status, 'pending')
      assert.equal(held.out.worker.running, true)
      assert.equal(held.out.lastLeaseRenewedAt, null)
    } finally {
      if (lock.acquired) lock.release()
    }

    // No worker: given up after --worker-timeout, told to start one.
    const gone = await waitJson(box, runId, ['--worker-timeout', '1000'])
    assert.equal(gone.code, 6)
    assert.equal(gone.out.worker.running, false)
    assert.match(gone.out.next[0] ?? '', /demo worker$/)
    const text = await demo(box, [
      'wait',
      '--run',
      runId,
      '--worker-timeout',
      '1',
    ])
    assert.equal(text.code, 6)
    assert.match(text.stdout, /worker: not running/)
    // Without the worker limit only --timeout ends it.
    const patient = await waitJson(box, runId, [
      '--no-worker-timeout',
      '--timeout',
      '2500',
    ])
    assert.equal(patient.code, 5)

    try {
      await durably.cancel(runId)
      const cancelled = await waitJson(box, runId, ['--timeout', '60000'])
      assert.equal(cancelled.code, 4)
      assert.equal(cancelled.out.status, 'cancelled')
    } finally {
      await durably.db.destroy()
    }
  })

  it('reports an unreadable lock as unknown, and neither fails nor gives up on it', async () => {
    const box = await sandbox()
    await mkdir(box.stateRoot, { recursive: true })
    const lockPath = join(box.stateRoot, 'worker.lock')
    assert.deepEqual(probeWorkerLock(box.stateRoot), {
      running: false,
      holder: null,
      unknownReason: null,
    })
    // Not a database: the lock says nothing either way.
    await writeFile(
      lockPath,
      'not a sqlite database, just some text '.repeat(8),
    )
    const corrupt = probeWorkerLock(box.stateRoot)
    assert.equal(corrupt.running, null)
    assert.match(corrupt.unknownReason ?? '', /worker\.lock/)
    if (process.getuid?.() !== 0) {
      await chmod(lockPath, 0o000)
      try {
        assert.equal(probeWorkerLock(box.stateRoot).running, null)
      } finally {
        await chmod(lockPath, 0o600)
      }
    }

    // `trigger` stores the run and still prints its id.
    const triggered = await demo(box, ['trigger', '--provider', 'fake'])
    assert.equal(triggered.code, 0, triggered.stderr)
    const shown = JSON.parse(triggered.stdout) as {
      runId: string
      worker: { running: boolean | null; start: string | null }
    }
    assert.ok(shown.runId)
    assert.equal(shown.worker.running, null)
    assert.equal(shown.worker.start, null)
    const runId = shown.runId
    const list = await demo(box, ['status'])
    assert.equal(list.code, 0, list.stderr)
    assert.match(list.stdout, /worker: unknown \(cannot read /)
    const one = await statusJson(box, runId)
    assert.equal(one.worker.running, null)

    // Unknown is not absent: only --timeout ends the wait.
    const held = await waitJson(box, runId, [
      '--worker-timeout',
      '1',
      '--timeout',
      '2500',
    ])
    assert.equal(held.code, 5)
    assert.equal(held.out.worker.running, null)
  })

  it('follows runs a worker in another process moves, until they end or wait on a person', async () => {
    const box = await sandbox({ check: CHECK })
    const subject = async () => {
      const res = await demo(box, ['trigger', '--provider', 'fake'])
      assert.equal(res.code, 0, res.stderr)
      return (JSON.parse(res.stdout) as { runId: string }).runId
    }
    const approved = await subject()
    const rejected = await subject()
    const other = await subject()
    const failed = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'fix add',
      '--base',
      'no-such-ref',
    ])
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    await durably.migrate()
    const workers: ReturnType<typeof startWorker>[] = []
    const pendingWait = async (runId: string) =>
      (await durably.getWaits(runId)).find((w) => w.status === 'pending')
    try {
      const first = startWorker(box)
      workers.push(first)
      await first.running()
      // Waits from pending, across the whole run, on the stored state.
      const human = await waitJson(box, approved)
      assert.equal(human.code, 2)
      assert.equal(human.out.status, 'waiting')
      assert.match(human.out.stopReason, /approval wait/)
      assert.ok(human.out.next.some((n) => /demo approve/.test(n)))
      assert.ok(human.out.stageTimings.some((t) => t.stage === 'code'))
      for (const t of human.out.stageTimings)
        if (!t.complete) assert.equal(t.elapsedMs, null)
      assert.equal((await waitJson(box, rejected)).code, 2)
      assert.equal((await waitJson(box, other)).code, 2)
      const stopped = await waitJson(box, failed)
      assert.equal(stopped.code, 3)
      assert.equal(stopped.out.status, 'failed')

      // A wait that is not a candidate approval still waits on a person.
      const otherWait = await pendingWait(other)
      assert.ok(otherWait)
      await durably.db
        .updateTable('durably_waits')
        .set({ metadata: null })
        .where('id', '=', otherWait.id)
        .execute()
      const input = await waitJson(box, other)
      assert.equal(input.code, 2)
      assert.match(input.out.stopReason, /nobody has resolved/)

      // Decided but not resumed: not a person's turn. Without a worker,
      // the wait gives up on the worker instead.
      first.kill('SIGTERM')
      assert.equal(await first.exited, 0)
      for (const [runId, verb] of [
        [approved, 'approve'],
        [rejected, 'reject'],
      ] as const) {
        const w = await pendingWait(runId)
        assert.ok(w)
        const res = await demo(box, [verb, '--run', runId, '--wait', w.id])
        assert.equal(res.code, 0, res.stderr)
      }
      const decided = await waitJson(box, approved, [
        '--worker-timeout',
        '1000',
      ])
      assert.equal(decided.code, 6)
      assert.equal(decided.out.status, 'waiting')

      const second = startWorker(box)
      workers.push(second)
      await second.running()
      const done = await demo(box, ['wait', '--run', approved])
      assert.equal(done.code, 0, done.stdout)
      assert.match(done.stdout, /conclusion: approved/)
      assert.match(done.stdout, /stopped: +completed: approved and delivered/)
      assert.match(done.stdout, /timing:\n {2}setup: work=/)
      const refused = await waitJson(box, rejected)
      assert.equal(refused.code, 3)
      assert.equal(refused.out.status, 'completed')
      assert.equal(refused.out.conclusion, 'rejected')
      second.kill('SIGTERM')
      assert.equal(await second.exited, 0)
    } finally {
      for (const w of workers) {
        w.kill('SIGKILL')
        w.child.kill('SIGKILL')
      }
      await durably.db.destroy()
    }
  })
})

describe('spec stages in factory.json', { timeout: 180000 }, () => {
  const SPEC_CONFIG = {
    template: 'spec-template.md',
    reviewTemplate: 'spec-review.md',
    author: {},
    review: {
      product: { output: 'findings-json' },
      tech: { command: '/spec-review {base} {effort}', effort: 'low' },
    },
    checkFromSpec: ['node', 'check-from-spec.mjs'],
  }

  it('fixes the roles, the templates and checkFromSpec at trigger, and leaves them out with --spec-file', async () => {
    const box = await sandbox({ spec: SPEC_CONFIG })
    await writeFile(join(box.repo, 'spec-template.md'), '# Template\n')
    await writeFile(join(box.repo, 'spec-review.md'), 'Review it.\n')
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'x'])
    // Editing the templates or the config afterwards changes nothing.
    await writeFile(join(box.repo, 'spec-template.md'), 'CHANGED\n')
    await writeFile(join(box.repo, 'factory.json'), '{"check":["false"]}')
    const input = (await inputOf(box, runId)) as RunInput & {
      spec?: {
        author: unknown
        fix: unknown
        reviewers: { name: string; invocation: unknown }[]
        maxRounds: number
        template: string | null
        reviewTemplate: string | null
        templateFiles: Record<string, { path: string } | null>
      }
      target: { checkFromSpec?: string[] | null }
    }
    assert.equal(input.target.checkCommand, null)
    assert.deepEqual(input.target.checkFromSpec, [
      'node',
      'check-from-spec.mjs',
    ])
    assert.equal(input.spec?.template, '# Template\n')
    assert.equal(input.spec?.reviewTemplate, 'Review it.\n')
    assert.equal(
      input.spec?.templateFiles['template']?.path,
      join(realpathSync(box.repo), 'spec-template.md'),
    )
    assert.equal(input.spec?.maxRounds, 3)
    assert.equal(input.spec?.fix, null)
    assert.deepEqual(
      input.spec?.reviewers.map((r) => [r.name, r.invocation]),
      [
        [
          'product',
          { command: null, context: 'prompt', output: 'findings-json' },
        ],
        [
          'tech',
          {
            command: '/spec-review {base} {effort}',
            context: 'prompt',
            output: 'verdict',
          },
        ],
      ],
    )

    // A spec given at trigger: no spec stages, the check still from it,
    // and a template that cannot be read is never read.
    const given = await sandbox({
      spec: { ...SPEC_CONFIG, template: 'missing.md' },
    })
    await writeFile(join(given.root, 'spec.md'), 'SPEC\n')
    const withSpec = await trigger(given, [
      '--repo',
      given.repo,
      '--task',
      'x',
      '--spec-file',
      'spec.md',
    ])
    const stored = (await inputOf(given, withSpec)) as RunInput & {
      spec?: unknown
      target: { checkFromSpec?: string[] | null }
    }
    assert.equal(stored.spec, undefined)
    assert.equal(stored.target.spec, 'SPEC\n')
    assert.deepEqual(stored.target.checkFromSpec, [
      'node',
      'check-from-spec.mjs',
    ])
  })

  it('refuses a bad round limit, reviewer, template or checkFromSpec before the run exists', async () => {
    for (const maxRounds of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const box = await sandbox({ spec: { ...SPEC_CONFIG, maxRounds } })
      await rejected(
        box,
        ['--repo', box.repo, '--task', 'x'],
        /invalid factory config[\s\S]*maxRounds/,
      )
    }
    for (const value of [Number.NaN, Infinity, -Infinity, 0, 2.5])
      assert.equal(specMaxRoundsSchema.safeParse(value).success, false)
    assert.equal(
      specMaxRoundsSchema.safeParse(Number.MAX_SAFE_INTEGER).success,
      true,
    )
    const { template: _t, reviewTemplate: _r, ...noTemplates } = SPEC_CONFIG
    for (const [config, message] of [
      [
        {
          spec: {
            ...noTemplates,
            review: { tech: { command: '/spec-review {head}' } },
          },
        },
        /spec\.review\.tech: command: \{head\} names a candidate commit/,
      ],
      [
        {
          spec: {
            ...noTemplates,
            review: { tech: { provider: 'codex', command: '/r' } },
          },
        },
        /spec\.review\.tech: a codex reviewer does not support command/,
      ],
      [
        { spec: { ...noTemplates, review: {} } },
        /spec\.review must name at least one reviewer/,
      ],
      [
        { spec: { ...noTemplates, review: { 'Bad Name': {} } } },
        /invalid factory config/,
      ],
      [{ spec: SPEC_CONFIG }, /spec\.template spec-template\.md: cannot read/],
      [
        { spec: { checkFromSpec: ['node', 'x.mjs'] } },
        /spec\.checkFromSpec reads the run's spec, and this run has none/,
      ],
      [
        { spec: { ...noTemplates, checkFromSpec: undefined } },
        /a check command is required/,
      ],
    ] as const) {
      const box = await sandbox(config)
      await rejected(box, ['--repo', box.repo, '--task', 'x'], message)
    }
  })
})

describe('compare --trend', { timeout: 120000 }, () => {
  it('refuses a --days that is not a whole number of days from 1, before reading anything', async () => {
    const box = await sandbox()
    for (const days of [
      '0',
      '-1',
      'NaN',
      'Infinity',
      '1.5',
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      const res = await demo(box, ['compare', '--trend', '--days', days])
      assert.notEqual(res.code, 0, days)
      assert.match(res.stderr, /--days must be a whole number of days/, days)
    }
    // A bare flag is refused too, and nothing was created on the way.
    assert.notEqual((await demo(box, ['compare', '--trend', '--days'])).code, 0)
    assert.equal(existsSync(dbPath(box.stateRoot)), false)
    const ok = await demo(box, [
      'compare',
      '--trend',
      '--days',
      String(Number.MAX_SAFE_INTEGER),
      '--format',
      'json',
    ])
    assert.equal(ok.code, 0, ok.stderr)
    assert.deepEqual(JSON.parse(ok.stdout), {
      days: Number.MAX_SAFE_INTEGER,
      includeFake: false,
      weeks: [],
      taskIds: [],
      fakeExcluded: 0,
      groups: [],
    })
    // The config-version comparison is still there, and still asks for runs.
    const noRuns = await demo(box, ['compare'])
    assert.notEqual(noRuns.code, 0)
    assert.match(noRuns.stderr, /--runs <id,id,...> required/)
  })
})

/** Whether a process this test started is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Signal a process this test started; one already gone is fine. */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

/**
 * Stop a process (or, with a negative pid, a process group) this test
 * started and wait until it is gone: SIGTERM first, SIGKILL if it outlives
 * the grace period, and an error if even that does not end it.
 */
async function reap(pid: number, graceMs = 5000): Promise<void> {
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    signal(pid, sig)
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      if (!alive(pid)) return
      // sleep-ok(poll): one tick of a loop that waits for the process to exit
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  if (alive(pid)) throw new Error(`process ${pid} survived SIGKILL`)
}

/** The pid of the worker a command says it started, or null. */
function startedWorker(stderr: string): number | null {
  const m = /started a worker \(pid (\d+)\)/.exec(stderr)
  return m ? Number(m[1]) : null
}

/**
 * Stop whatever worker holds a test's own temporary state root, read from
 * that root's worker.json, so a worker whose pid the test never got to
 * record is still stopped; then confirm the lock is free. Once a worker has
 * been started there (its logs exist), the lock must stay free for a quiet
 * period, so a worker spawned just before a failure but still loading is
 * caught when it takes the lock.
 */
async function reapRootWorker(stateRoot: string): Promise<void> {
  const quietMs = existsSync(join(stateRoot, 'logs')) ? 5000 : 0
  const deadline = Date.now() + 30000
  let freeSince = Date.now()
  for (;;) {
    const presence = probeWorkerLock(stateRoot)
    if (presence.running === false) {
      if (Date.now() - freeSince >= quietMs) return
    } else {
      if (presence.holder) await reap(presence.holder.pid)
      freeSince = Date.now()
      if (Date.now() > deadline)
        throw new Error(`a worker still holds ${stateRoot}`)
    }
    // sleep-ok(poll): the holder note may lag the lock, and a worker just
    // spawned takes the lock only once it has loaded
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Every auto-started worker log under a state root, read together. */
async function workerLogs(stateRoot: string): Promise<string> {
  const dir = join(stateRoot, 'logs')
  if (!existsSync(dir)) return ''
  const names = await readdir(dir)
  const texts = await Promise.all(
    names.map((n) => readFile(join(dir, n), 'utf8')),
  )
  return texts.join('')
}

/** Commands run with auto-start on, as a person would. */
const AUTO = { LOCAL_AGENT_LOOP_NO_AUTO_WORKER: '0' }

/**
 * Rows written straight into a state database, for the runs an idle worker
 * counts. A run of another job holds a lease on concurrency key `K` far into
 * the future, so the worker can claim no agent-loop run on `K`: a pending
 * or resumable run stays as written and only the idle check sees it.
 */
async function seededDatabase(box: Sandbox) {
  const durably = createAgentDurably({ stateRoot: box.stateRoot })
  await durably.migrate()
  await durably.db.destroy()
  const db = new Database(dbPath(box.stateRoot), { timeout: 10000 })
  const now = new Date().toISOString()
  const run = (
    id: string,
    fields: {
      job?: string
      status: string
      leaseOwner?: string
      waitId?: string
    },
  ) =>
    db
      .prepare(
        `INSERT INTO durably_runs (id, job_name, input, status, concurrency_key,
           current_step_index, completed_step_count, labels, lease_owner,
           lease_expires_at, lease_generation, waiting_on_wait_id, created_at,
           updated_at)
         VALUES (?, ?, '{}', ?, 'K', 0, 0, '{}', ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        fields.job ?? AGENT_LOOP_JOB_NAME,
        fields.status,
        fields.leaseOwner ?? null,
        fields.leaseOwner ? '2099-01-01T00:00:00.000Z' : null,
        fields.waitId ?? null,
        now,
        now,
      )
  run('blocker', { job: 'blocker', status: 'leased', leaseOwner: 'elsewhere' })
  return {
    run,
    wait: (id: string, runId: string, status: string) =>
      db
        .prepare(
          `INSERT INTO durably_waits (id, run_id, name, status, created_at)
           VALUES (?, ?, 'decision', ?, ?)`,
        )
        .run(id, runId, status, now),
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  }
}

describe('worker --exit-when-idle', { timeout: 240000 }, () => {
  it('refuses an idle period outside 1 to 2147483647 ms before taking the lock', async () => {
    const box = await sandbox()
    for (const value of [
      '0',
      '-1',
      '1.5',
      'NaN',
      'Infinity',
      '2147483648',
      '9007199254740993',
      '1e3',
    ]) {
      const res = await demo(box, [
        'worker',
        '--exit-when-idle',
        '--idle-ms',
        value,
      ])
      assert.notEqual(res.code, 0, value)
      assert.match(res.stderr, /--idle-ms must be an integer/, value)
    }
    const bare = await demo(box, ['worker', '--exit-when-idle', '--idle-ms'])
    assert.notEqual(bare.code, 0)
    const alone = await demo(box, ['worker', '--idle-ms', '1000'])
    assert.notEqual(alone.code, 0)
    assert.match(alone.stderr, /--idle-ms applies only with --exit-when-idle/)
    // No worker ever started on this root.
    assert.equal(existsSync(join(box.stateRoot, 'worker.lock')), false)
  })

  it('stays up while a run is pending, leased or resumable, and stops once only an undecided wait is left', async () => {
    const box = await sandbox()
    const rows = await seededDatabase(box)
    const worker = startWorker(box, {}, [
      '--exit-when-idle',
      '--idle-ms',
      '300',
    ])
    try {
      rows.run('pending-run', { status: 'pending' })
      await worker.running()
      // sleep-ok(negative): an idle stop would have to happen within this window; a slow machine only hides one
      await new Promise((r) => setTimeout(r, 2000))
      assert.ok(alive(worker.pid()), worker.output())
      assert.doesNotMatch(worker.output(), /\[shutdown\]/)

      // A run leased by someone else, lease or not, is work too.
      rows.exec('BEGIN')
      rows.exec("DELETE FROM durably_runs WHERE id = 'pending-run'")
      rows.run('leased-run', { status: 'leased', leaseOwner: 'elsewhere' })
      rows.exec('COMMIT')
      // sleep-ok(negative): as above, for the leased run
      await new Promise((r) => setTimeout(r, 2000))
      assert.ok(alive(worker.pid()), worker.output())

      // A waiting run whose wait was decided is resumed without turning
      // pending first, so it is work as well.
      rows.exec('BEGIN')
      rows.exec("DELETE FROM durably_runs WHERE id = 'leased-run'")
      rows.run('waiting-run', { status: 'waiting', waitId: 'wait-1' })
      rows.wait('wait-1', 'waiting-run', 'resolved')
      rows.exec('COMMIT')
      // sleep-ok(negative): as above, for the decided wait
      await new Promise((r) => setTimeout(r, 2000))
      assert.ok(alive(worker.pid()), worker.output())

      // Only a wait nobody decided is left: the worker stops by itself.
      rows.exec(
        "UPDATE durably_waits SET status = 'pending' WHERE id = 'wait-1'",
      )
      assert.equal(await worker.exited, 0)
      assert.match(worker.output(), /\[shutdown\] reason=idle/)
      assert.equal(probeWorkerLock(box.stateRoot).running, false)
    } finally {
      worker.kill('SIGKILL')
      await worker.exited
      rows.close()
    }
  })

  it('stops on SIGINT and SIGTERM with the reason logged, and without the flag stays up while idle', async () => {
    const box = await sandbox()
    const plain = startWorker(box)
    try {
      await plain.running()
      // sleep-ok(negative): an idle stop the plain worker must not make would happen in this window
      await new Promise((r) => setTimeout(r, 1500))
      assert.ok(alive(plain.pid()), plain.output())
      plain.kill('SIGINT')
      assert.equal(await plain.exited, 0)
      assert.match(plain.output(), /\[shutdown\] reason=SIGINT/)
    } finally {
      plain.kill('SIGKILL')
      await plain.exited
    }
    const idle = startWorker(box, {}, [
      '--exit-when-idle',
      '--idle-ms',
      '60000',
    ])
    try {
      await idle.running()
      idle.kill('SIGTERM')
      assert.equal(await idle.exited, 0)
      assert.match(idle.output(), /\[shutdown\] reason=SIGTERM/)
      assert.equal(idle.output().match(/\[shutdown\]/g)?.length, 1)
    } finally {
      idle.kill('SIGKILL')
      await idle.exited
    }
  })
})

describe('auto-started worker', { timeout: 300000 }, () => {
  /** Wait for an auto-started worker to stop by itself after its work. */
  async function stopsWhenIdle(pid: number, label: string) {
    await until(async () => !alive(pid), `${label}: worker ${pid} stops`)
  }

  it('starts after trigger, retrigger, approve and reject when work needs one, and stops when idle', async () => {
    const box = await sandbox()
    const env = { ...AUTO, LOCAL_AGENT_LOOP_IDLE_MS: '500' }
    const started: number[] = []
    /** Run a command, recording any worker it started before anything else. */
    const run = async (args: string[], extra: Record<string, string> = {}) => {
      const res = await demo(box, args, { ...env, ...extra })
      const pid = startedWorker(res.stderr)
      if (pid !== null) started.push(pid)
      return { ...res, pid }
    }
    const db = createAgentDurably({ stateRoot: box.stateRoot })
    try {
      // The fake check fails first: one iteration stops verification-failed.
      const first = await run([
        'trigger',
        '--provider',
        'fake',
        '--max-iterations',
        '1',
      ])
      assert.equal(first.code, 0, first.stderr)
      // stdout is still the trigger's JSON alone.
      const firstJson = JSON.parse(first.stdout) as {
        runId: string
        worker: {
          start: string | null
          autoStarted?: { pid: number; log: string }
        }
      }
      const firstId = firstJson.runId
      const w1 = first.pid
      assert.ok(w1, first.stderr)
      const today = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      const log = join(
        box.stateRoot,
        'logs',
        `worker-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.log`,
      )
      assert.ok(first.stderr.includes(log), first.stderr)
      // The JSON names the worker it started instead of a command to start
      // one by hand.
      assert.equal(firstJson.worker.start, null)
      assert.deepEqual(firstJson.worker.autoStarted, { pid: w1, log })
      await stopsWhenIdle(w1, 'trigger')
      await db.migrate()
      assert.equal((await db.getRun(firstId))?.status, 'completed')

      // retrigger: a new run, and a worker for it, which stops once the run
      // waits on a person.
      const again = await run(['retrigger', '--run', firstId], {
        FAKE_FAIL_FIRST: '0',
      })
      assert.equal(again.code, 0, again.stderr)
      const secondId = /^new run (\S+)/.exec(again.stdout)?.[1] ?? ''
      const w2 = again.pid
      assert.ok(w2, again.stderr)
      await stopsWhenIdle(w2, 'retrigger')
      const second = await db.getRun(secondId)
      assert.equal(second?.status, 'waiting')
      const waitId = second?.waitingOnWaitId ?? ''

      // A failed command starts nothing.
      const bad = await run([
        'approve',
        '--run',
        secondId,
        '--wait',
        'no-such-wait',
      ])
      assert.notEqual(bad.code, 0)
      assert.equal(bad.pid, null, bad.stderr)
      const missing = await run(['retrigger', '--run', 'nope'])
      assert.notEqual(missing.code, 0)
      assert.equal(missing.pid, null, missing.stderr)

      // approve: the decided wait is resumed as it is.
      const approved = await run([
        'approve',
        '--run',
        secondId,
        '--wait',
        waitId,
      ])
      assert.equal(approved.code, 0, approved.stderr)
      const w3 = approved.pid
      assert.ok(w3, approved.stderr)
      await stopsWhenIdle(w3, 'approve')
      assert.equal((await db.getRun(secondId))?.status, 'completed')

      // reject, on a third run.
      const third = await run(['trigger', '--provider', 'fake'], {
        FAKE_FAIL_FIRST: '0',
      })
      assert.equal(third.code, 0, third.stderr)
      const thirdId = (JSON.parse(third.stdout) as { runId: string }).runId
      const w4 = third.pid
      assert.ok(w4, third.stderr)
      await stopsWhenIdle(w4, 'trigger')
      const thirdRun = await db.getRun(thirdId)
      assert.equal(thirdRun?.status, 'waiting')
      const rejected = await run([
        'reject',
        '--run',
        thirdId,
        '--wait',
        thirdRun?.waitingOnWaitId ?? '',
      ])
      assert.equal(rejected.code, 0, rejected.stderr)
      const w5 = rejected.pid
      assert.ok(w5, rejected.stderr)
      await stopsWhenIdle(w5, 'reject')
      assert.equal((await db.getRun(thirdId))?.status, 'completed')

      // One log for the day, appended by every worker in turn.
      const text = await readFile(log, 'utf8')
      assert.equal(text.match(/\[shutdown\] reason=idle/g)?.length, 5, text)
      for (const pid of started)
        assert.match(text, new RegExp(`worker running, pid ${pid}\\b`))
    } finally {
      await Promise.all(started.map((pid) => reap(pid)))
      await db.db.destroy()
      await reapRootWorker(box.stateRoot)
    }
  })

  it('starts no second worker, none when switched off, and none when the lock cannot be read', async () => {
    const box = await sandbox()
    const unreadable = await sandbox()
    const env = { ...AUTO, LOCAL_AGENT_LOOP_IDLE_MS: '500' }
    const started: number[] = []
    /** Run a command, recording any worker it started before anything else. */
    const run = async (
      target: Sandbox,
      args: string[],
      runEnv: Record<string, string> = env,
    ) => {
      const res = await demo(target, args, runEnv)
      const pid = startedWorker(res.stderr)
      if (pid !== null) started.push(pid)
      return { ...res, pid }
    }
    try {
      // Switched off by the flag (repair accepts it too) or the variable:
      // the run stays pending and no worker starts.
      const flagged = await run(box, [
        'trigger',
        '--provider',
        'fake',
        '--no-auto-worker',
      ])
      assert.equal(flagged.code, 0, flagged.stderr)
      assert.equal(flagged.pid, null, flagged.stderr)
      const off = await run(box, ['trigger', '--provider', 'fake'], {
        LOCAL_AGENT_LOOP_NO_AUTO_WORKER: '1',
      })
      assert.equal(off.code, 0, off.stderr)
      assert.equal(off.pid, null, off.stderr)
      const repair = await run(box, [
        'repair',
        '--run',
        'nope',
        '--no-auto-worker',
      ])
      assert.notEqual(repair.code, 0)
      assert.doesNotMatch(repair.stderr, /not accepted/)
      assert.equal(repair.pid, null, repair.stderr)
      assert.equal(probeWorkerLock(box.stateRoot).running, false)
      assert.equal(existsSync(join(box.stateRoot, 'logs')), false)
      const db = createAgentDurably({ stateRoot: box.stateRoot })
      try {
        await db.migrate()
        for (const out of [flagged.stdout, off.stdout]) {
          const json = JSON.parse(out) as {
            runId: string
            worker: Record<string, unknown>
          }
          assert.equal((await db.getRun(json.runId))?.status, 'pending')
          // Switched off, the JSON is as it always was.
          assert.deepEqual(json.worker, {
            running: false,
            pid: null,
            startedAt: null,
            start: 'pnpm --filter example-local-agent-loop demo worker',
            unknownReason: null,
          })
        }
      } finally {
        await db.db.destroy()
      }

      // An idle period out of range starts no worker; the trigger itself
      // still succeeds.
      for (const value of [
        '0',
        '-5',
        '2.5',
        'NaN',
        'Infinity',
        '2147483648',
        '9007199254740993',
      ]) {
        const res = await run(box, ['trigger', '--provider', 'fake'], {
          ...AUTO,
          LOCAL_AGENT_LOOP_IDLE_MS: value,
        })
        assert.equal(res.code, 0, res.stderr)
        JSON.parse(res.stdout)
        assert.equal(res.pid, null, value)
        assert.match(res.stderr, /LOCAL_AGENT_LOOP_IDLE_MS must be/, value)
      }

      // A worker already runs: none is started beside it, and it takes the
      // run.
      const running = startWorker(box, { FAKE_FAIL_FIRST: '0' })
      try {
        await running.running()
        const res = await run(box, ['trigger', '--provider', 'fake'])
        assert.equal(res.code, 0, res.stderr)
        assert.equal(res.pid, null, res.stderr)
        const json = JSON.parse(res.stdout) as {
          worker: { running: boolean | null; start: string | null }
        }
        assert.equal(json.worker.running, true)
        assert.equal(json.worker.start, null)
        assert.equal('autoStarted' in json.worker, false)
        running.kill('SIGTERM')
        assert.equal(await running.exited, 0)
      } finally {
        running.kill('SIGKILL')
        await running.exited
      }

      // Whether a worker runs cannot be told: a warning, and no worker.
      await mkdir(join(unreadable.stateRoot, 'worker.lock'), {
        recursive: true,
      })
      const res = await run(unreadable, ['trigger', '--provider', 'fake'])
      assert.equal(res.code, 0, res.stderr)
      JSON.parse(res.stdout)
      assert.equal(res.pid, null, res.stderr)
      assert.match(
        res.stderr,
        /no worker started: whether a worker runs is unknown/,
      )
    } finally {
      await Promise.all(started.map((pid) => reap(pid)))
      await reapRootWorker(box.stateRoot)
    }
  })

  it('outlives the process group of the shell that triggered it', async () => {
    const box = await sandbox()
    const errFile = join(box.root, 'trigger.err')
    // The shell leads a process group of its own, so signalling that group
    // reaches the shell and the trigger but never this test runner.
    const shell = spawn(
      '/bin/sh',
      [
        '-c',
        `"$0" "$1" trigger --provider fake 2>"$2" >/dev/null; exec sleep 120`,
        tsx,
        cli,
        errFile,
      ],
      {
        cwd: box.root,
        env: {
          ...process.env,
          HOME: box.home,
          LOCAL_AGENT_LOOP_NO_AUTO_WORKER: '0',
          LOCAL_AGENT_LOOP_IDLE_MS: '60000',
        },
        detached: true,
        stdio: 'ignore',
      },
    )
    const shellPid = shell.pid
    // Never 0: a negative 0 would signal this runner's own group.
    assert.ok(shellPid !== undefined && shellPid > 0)
    const shellExited = new Promise<void>((resolve) => {
      shell.once('exit', () => resolve())
      shell.once('error', () => resolve())
    })
    let workerPid: number | null = null
    try {
      await until(async () => {
        workerPid = existsSync(errFile)
          ? startedWorker(await readFile(errFile, 'utf8'))
          : null
        return workerPid !== null
      }, 'the trigger starts a worker')
      const pid = workerPid ?? 0
      await until(
        async () => existsSync(join(box.stateRoot, 'worker.json')),
        'the worker takes the lock',
      )
      const holder = JSON.parse(
        await readFile(join(box.stateRoot, 'worker.json'), 'utf8'),
      ) as { pid: number }
      assert.equal(holder.pid, pid)

      process.kill(-shellPid, 'SIGTERM')
      await shellExited
      assert.ok(alive(pid), 'the worker died with the shell')
      const pgid = await runChild('ps', ['-o', 'pgid=', '-p', String(pid)], {
        timeoutMs: 10000,
      })
      assert.equal(pgid.code, 0, pgid.stderr)
      assert.notEqual(Number(pgid.stdout.trim()), shellPid)

      signal(pid, 'SIGTERM')
      await until(async () => !alive(pid), 'the worker stops on SIGTERM')
      assert.match(
        await workerLogs(box.stateRoot),
        /\[shutdown\] reason=SIGTERM/,
      )
      assert.equal(probeWorkerLock(box.stateRoot).running, false)
    } finally {
      await reap(-shellPid)
      await shellExited
      if (workerPid !== null) await reap(workerPid)
      await reapRootWorker(box.stateRoot)
    }
  })
})

describe('--context-file', { timeout: 180000 }, () => {
  /** A context whose Markdown would read as report headings and fences. */
  const CONTEXT = [
    '# Decisions',
    '',
    '## Settled',
    '',
    'mul() keeps its integer wiring; do not change it.',
    '````',
    'not the end of anything',
    '````',
    '',
  ].join('\n')

  it('stores the content and the path at trigger, and reads neither again', async () => {
    const box = await sandbox({ check: CHECK })
    await writeFile(join(box.root, 'context.md'), CONTEXT)
    await writeFile(
      join(box.root, 'dispositions.md'),
      'mul() is out of scope\n',
    )
    const runId = await trigger(box, [
      '--repo',
      box.repo,
      '--task',
      'Fix add()',
      '--dispositions-file',
      'dispositions.md',
      '--context-file',
      'context.md',
    ])
    await writeFile(join(box.root, 'context.md'), 'DIFFERENT CONTEXT\n')
    await rm(join(box.root, 'dispositions.md'))

    const input = (await inputOf(box, runId)) as RunInput & {
      target: { context?: string | null }
    }
    assert.equal(input.target.context, CONTEXT)
    assert.deepEqual(input.target.inputFiles['context'], {
      path: join(realpathSync(box.root), 'context.md'),
    })
    // Dispositions stay as they were: their own input, not the context.
    assert.equal(input.target.dispositions, 'mul() is out of scope\n')

    // The report shows the stored content, its path and its hash, the
    // Markdown fenced past every backtick run in it.
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    try {
      await durably.migrate()
      const report = await buildReport(durably, runId)
      assert.deepEqual(report.inputs.context, {
        path: join(realpathSync(box.root), 'context.md'),
        sha256: sha256(CONTEXT),
        content: CONTEXT,
      })
      assert.ok(reportToJson(report).includes(sha256(CONTEXT)))
      const markdown = reportToMarkdown(report)
      assert.ok(!markdown.includes('DIFFERENT'))
      // Its path and hash once, among the inputs; its content in a section
      // of its own.
      assert.ok(
        markdown.includes(
          `- context: ${sha256(CONTEXT)} (${join(realpathSync(box.root), 'context.md')})`,
        ),
      )
      assert.equal(markdown.split(sha256(CONTEXT)).length, 2)
      const section = markdown.split('## Owner context (trusted, as stored)')[1]
      // Five backticks: one more than the longest run in the content.
      assert.ok(
        section?.includes(`\n\`\`\`\`\`\n${CONTEXT.trimEnd()}\n\`\`\`\`\`\n`),
      )
      // Its headings appear only inside that fence, so none is the report's.
      assert.equal(markdown.split('\n## Settled\n').length, 2)
    } finally {
      await durably.db.destroy()
    }
  })

  it('reports a run without a context, and one stored before it existed', async () => {
    const box = await sandbox({ check: CHECK })
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'Fix'])
    const input = await inputOf(box, runId)
    assert.equal((input.target as { context?: unknown }).context, null)
    // A run stored before the context existed has neither field.
    const db = new Database(dbPath(box.stateRoot))
    try {
      const older = structuredClone(input) as RunInput & {
        target: { context?: unknown }
      }
      delete older.target.context
      delete older.target.inputFiles['context']
      db.prepare('UPDATE durably_runs SET input = ? WHERE id = ?').run(
        JSON.stringify(older),
        runId,
      )
    } finally {
      db.close()
    }
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    try {
      await durably.migrate()
      const report = await buildReport(durably, runId)
      assert.equal(report.inputs.context, null)
      const markdown = reportToMarkdown(report)
      assert.match(markdown, /\n- context: not given\n/)
      assert.ok(!markdown.includes('## Owner context'))
    } finally {
      await durably.db.destroy()
    }
  })

  it('reports a context stored without the file it was read from', async () => {
    const box = await sandbox({ check: CHECK })
    const runId = await trigger(box, ['--repo', box.repo, '--task', 'Fix'])
    const input = (await inputOf(box, runId)) as RunInput & {
      target: { context?: unknown }
    }
    // As a run triggered through the API, not the CLI, may store it.
    input.target.context = CONTEXT
    delete input.target.inputFiles['context']
    const db = new Database(dbPath(box.stateRoot))
    try {
      db.prepare('UPDATE durably_runs SET input = ? WHERE id = ?').run(
        JSON.stringify(input),
        runId,
      )
    } finally {
      db.close()
    }
    const durably = createAgentDurably({ stateRoot: box.stateRoot })
    try {
      await durably.migrate()
      const report = await buildReport(durably, runId)
      assert.deepEqual(report.inputs.context, {
        path: null,
        sha256: sha256(CONTEXT),
        content: CONTEXT,
      })
      const markdown = reportToMarkdown(report)
      assert.ok(
        markdown.includes(
          `- context: ${sha256(CONTEXT)} (stored without a file)`,
        ),
      )
      assert.ok(markdown.includes('## Owner context (trusted, as stored)'))
    } finally {
      await durably.db.destroy()
    }
  })

  it('accepts 32 KiB and refuses more, an empty file or one not UTF-8, before the run exists', async () => {
    const box = await sandbox({ check: CHECK })
    await writeFile(join(box.root, 'edge.md'), 'x'.repeat(32 * 1024))
    await writeFile(join(box.root, 'big.md'), 'x'.repeat(32 * 1024 + 1))
    await writeFile(join(box.root, 'empty.md'), ' \n\t\n')
    await writeFile(join(box.root, 'bad.md'), Buffer.from([0x66, 0xff, 0xfe]))
    const base = ['--repo', box.repo, '--task', 'x', '--context-file']
    await rejected(
      box,
      [...base, 'big.md'],
      /--context-file big\.md: file is 32769 bytes; the limit is 32 KiB/,
    )
    await rejected(
      box,
      [...base, 'empty.md'],
      /--context-file empty\.md: file is empty/,
    )
    await rejected(
      box,
      [...base, 'bad.md'],
      /--context-file bad\.md: not UTF-8 text/,
    )
    await rejected(
      box,
      [...base, 'gone.md'],
      /--context-file gone\.md: cannot read file/,
    )
    await rejected(
      box,
      ['--context-file', 'edge.md'],
      /--context-file needs --repo <path>/,
    )
    const runId = await trigger(box, [...base, 'edge.md'])
    const input = await inputOf(box, runId)
    assert.equal(
      (input.target as { context?: string }).context,
      'x'.repeat(32 * 1024),
    )
  })

  it('refuses a stored context over 32 KiB, counted in UTF-8 bytes', async () => {
    const durably = createAgentDurably({
      stateRoot: await mkdtemp(join(tmpdir(), 'context-schema-')),
    })
    await durably.migrate()
    const target = (context: string) => ({
      provider: 'fake' as const,
      target: {
        kind: 'repo' as const,
        repoPath: '/repo',
        baseRef: 'HEAD',
        task: 'task',
        spec: null,
        dispositions: null,
        context,
        inputFiles: { task: null, spec: null, dispositions: null },
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        publish: false,
      },
      maxIterations: 1,
      context: 'reuse' as const,
      checkTimeoutMs: 120000,
      agentTimeoutMs: 600000,
      codexPath: null,
    })
    try {
      // 10,923 three-byte characters: fewer than 32,768 code units, more
      // than 32,768 bytes.
      await assert.rejects(
        durably.jobs.agentLoop.trigger(target('あ'.repeat(10923))),
        /the context is 32769 bytes; the limit is 32 KiB/,
      )
      // Nor a blank one, which `--context-file` refuses too.
      await assert.rejects(
        durably.jobs.agentLoop.trigger(target(' \n\t')),
        /the context is empty/,
      )
      await durably.jobs.agentLoop.trigger(target('あ'.repeat(10922)))
    } finally {
      await durably.db.destroy()
    }
  })

  it('checks a repair run context file like trigger does', async () => {
    const root = await mkdtemp(join(tmpdir(), 'context-repair-'))
    await writeFile(join(root, 'big.md'), 'x'.repeat(32 * 1024 + 1))
    await writeFile(join(root, 'ok.md'), CONTEXT)
    await assert.rejects(
      readRepairFiles({ run: 'p', 'context-file': join(root, 'big.md') }),
      /--context-file .*big\.md: file is 32769 bytes; the limit is 32 KiB/,
    )
    const files = await readRepairFiles({
      run: 'p',
      'context-file': join(root, 'ok.md'),
    })
    assert.deepEqual(files.context, {
      content: CONTEXT,
      ref: { path: join(root, 'ok.md') },
    })
    assert.equal((await readRepairFiles({ run: 'p' })).context, null)
  })

  it("inherits the parent's context, replaces it when given, and names its content in the child's identity", () => {
    const commit = 'a'.repeat(40)
    const profile = (role: string) => ({
      id: `fake:provider-default:provider-default:${role}`,
      provider: 'fake',
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
    })
    const parent = (context: string | null) => ({
      id: 'p',
      status: 'completed',
      input: {
        provider: 'fake',
        target: {
          kind: 'repo',
          inputFiles: {
            task: null,
            spec: null,
            dispositions: null,
            ...(context ? { context: { path: '/parent-context.md' } } : {}),
          },
        },
      },
      output: {
        approved: true,
        conclusion: 'approved',
        candidate: { commit, branch: 'factory/p' },
        delivery: { commit },
      },
    })
    const setup = (context: string | null) => ({
      contextMode: 'reuse',
      maxIterations: 1,
      agentTimeoutMs: 600000,
      autoApprove: true,
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
      },
      target: {
        kind: 'repo',
        repoPath: '/repo',
        task: 'task',
        spec: null,
        dispositions: 'DISPOSITIONS',
        // A parent set up before the context existed has no field.
        ...(context !== null ? { context } : {}),
        issue: null,
        checkCommand: ['true'],
        setupCommand: null,
        checkTimeoutMs: 120000,
        publish: false,
      },
    })
    const findings = { content: 'FINDING\n', ref: { path: '/f.md' } }
    const repair = (
      parentContext: string | null,
      context?: { content: string; path: string },
    ) =>
      buildRepairInput(parent(parentContext), setup(parentContext), {
        findings,
        dispositions: null,
        ...(context
          ? {
              context: {
                content: context.content,
                ref: { path: context.path },
              },
            }
          : {}),
      })

    // Inherited, content and path both.
    const inherited = repair('PARENT CONTEXT')
    assert.equal(inherited.input.target.context, 'PARENT CONTEXT')
    assert.deepEqual(inherited.input.target.inputFiles.context, {
      path: '/parent-context.md',
    })
    // Dispositions are inherited on their own, as before.
    assert.equal(inherited.input.target.dispositions, 'DISPOSITIONS')
    // Replaced, content and path both.
    const replaced = repair('PARENT CONTEXT', {
      content: 'CHILD CONTEXT',
      path: '/child.md',
    })
    assert.equal(replaced.input.target.context, 'CHILD CONTEXT')
    assert.deepEqual(replaced.input.target.inputFiles.context, {
      path: '/child.md',
    })
    assert.notEqual(replaced.idempotencyKey, inherited.idempotencyKey)
    // The same content from another path is the same child; given or
    // inherited, the same content is the same child too.
    assert.equal(
      repair('PARENT CONTEXT', {
        content: 'CHILD CONTEXT',
        path: '/elsewhere.md',
      }).idempotencyKey,
      replaced.idempotencyKey,
    )
    assert.equal(
      repair('PARENT CONTEXT', {
        content: 'PARENT CONTEXT',
        path: '/again.md',
      }).idempotencyKey,
      inherited.idempotencyKey,
    )
    assert.ok(
      inherited.idempotencyKey.endsWith(`-context-${sha256('PARENT CONTEXT')}`),
    )
    // Without a context, the key is the one a child got before it existed.
    const none = repair(null)
    assert.equal(none.input.target.context, null)
    assert.equal(none.input.target.inputFiles.context, null)
    assert.equal(
      none.idempotencyKey,
      `repair-of-p-findings-${sha256('FINDING\n')}-dispositions-${sha256('DISPOSITIONS')}`,
    )
    assert.notEqual(
      repair(null, { content: 'NEW', path: '/new.md' }).idempotencyKey,
      none.idempotencyKey,
    )
  })
})
