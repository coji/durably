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
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably, dbPath } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import {
  codePrompt,
  reviewPrompt,
  triagePrompt,
} from '../src/factory/prompts.js'
import type { FactorySetup } from '../src/factory/types.js'
import { createTarget } from '../src/targets/index.js'

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
    checkCommand: string[]
    setupCommand: string[] | null
    inputFiles: Record<string, { path: string } | null>
    baselineCheck?: boolean
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
    assert.ok(existsSync(join(box.stateRoot, 'runs', runId, 'work')))
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

    // A repository run that finishes (its worktree is kept), and one whose
    // setup fails before any worktree is recorded.
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
      assert.ok(existsSync(workdir))
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
    // The finished repository run's worktree is still on disk: offer a
    // non-forcing removal of exactly that path. The run that failed before
    // setup and the sample run get none.
    const remove = `git -C '${repoPath}' worktree remove '${workdir}'`
    assert.ok(blockOf(out, done).includes(remove), out)
    assert.doesNotMatch(out, /--force|branch -D/)
    for (const id of [noSetup, waiting, pending, live, expired])
      assert.doesNotMatch(blockOf(out, id), /worktree remove/)

    // Once the worktree is gone, the run is not mentioned again.
    await git(repoPath, ['worktree', 'remove', workdir])
    const after = await demo(box, ['status'])
    assert.equal(after.code, 0, after.stderr)
    assert.equal(blockOf(after.stdout, done), '')
    assert.doesNotMatch(after.stdout, /worktree remove/)

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
    })
    const fromConfig = await trigger(box, ['--repo', box.repo, '--task', 'x'], {
      TEST_TIMEOUT_MS: '1',
      AGENT_TIMEOUT_MS: '1',
    })
    const configured = await inputOf(box, fromConfig)
    assert.equal(configured.checkTimeoutMs, 45000)
    assert.equal(configured.agentTimeoutMs, 600000)

    const plain = await sandbox({ check: CHECK })
    const fromEnv = await trigger(
      plain,
      ['--repo', plain.repo, '--task', 'x'],
      {
        TEST_TIMEOUT_MS: '30000',
        AGENT_TIMEOUT_MS: '400000',
      },
    )
    const env = await inputOf(plain, fromEnv)
    assert.equal(env.checkTimeoutMs, 30000)
    assert.equal(env.agentTimeoutMs, 400000)
    // Neither: the target's own default, fixed all the same.
    const byDefault = await inputOf(
      plain,
      await trigger(plain, ['--repo', plain.repo, '--task', 'x']),
    )
    assert.equal(byDefault.checkTimeoutMs, 900000)
    assert.equal(byDefault.agentTimeoutMs, 1800000)
    const subject = await inputOf(plain, await trigger(plain, []))
    assert.equal(subject.checkTimeoutMs, 120000)
    assert.equal(subject.agentTimeoutMs, 300000)

    // The worker's environment no longer reaches a stored run: a 1 ms agent
    // timeout would fail every call, and the run still completes with the
    // values fixed at trigger.
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    process.env.TEST_TIMEOUT_MS = '1'
    process.env.AGENT_TIMEOUT_MS = '1'
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
    }
  })

  it('refuses a timeout that is not a positive safe integer', async () => {
    // 2^31 ms and up overflow Node's timers and fire after about 1 ms.
    for (const bad of [0, -1, 1.5, 2 ** 31, Number.MAX_SAFE_INTEGER + 2]) {
      for (const key of ['checkTimeoutMs', 'agentTimeoutMs']) {
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
      for (const name of ['TEST_TIMEOUT_MS', 'AGENT_TIMEOUT_MS'])
        await rejected(
          box,
          ['--repo', box.repo, '--task', 'x'],
          new RegExp(`${name} must be a positive integer`),
          { [name]: bad },
        )
    }
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

    // Left out: no pin, so the bundled CLI and PATH fallback stay, and no
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
})

describe('retrigger --reload-config', { timeout: 240000 }, () => {
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

describe('one worker per state root', { timeout: 240000 }, () => {
  /** A worker process, with its output so far. */
  function startWorker(box: Sandbox, env: Record<string, string> = {}) {
    const child = spawn(tsx, [cli, 'worker'], {
      cwd: box.root,
      env: { ...process.env, HOME: box.home, FAKE_FAIL_FIRST: '0', ...env },
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
      running: () =>
        until(async () => Number.isInteger(pid()), 'worker starts'),
      kill: (signal: NodeJS.Signals) => {
        try {
          process.kill(pid(), signal)
        } catch {
          // Already gone.
        }
      },
    }
  }

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
})
