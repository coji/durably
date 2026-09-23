/**
 * The CLI boundary: `factory.json`, flag overrides, input files, validation
 * and the trigger-time snapshot.
 *
 * Each command runs the real CLI in a child process with `HOME` pointed at a
 * temporary directory, so the fixed state root resolves there and the
 * user's own database is never read or written.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably, dbPath } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import { codePrompt, reviewPrompt } from '../src/factory/prompts.js'
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

async function demo(box: Sandbox, args: string[]) {
  return runChild(tsx, [cli, ...args], {
    cwd: box.root,
    timeoutMs: 60000,
    maxOutputChars: 10_000_000,
    env: {
      HOME: box.home,
      // Must not move the database anywhere.
      DURABLY_DB: join(box.root, 'durably-db-override.db'),
    },
  })
}

async function trigger(box: Sandbox, args: string[]): Promise<string> {
  const res = await demo(box, ['trigger', ...args])
  assert.equal(res.code, 0, res.stderr)
  const out = JSON.parse(res.stdout) as { runId: string; db: string }
  assert.equal(out.db, dbPath(box.stateRoot))
  return out.runId
}

async function rejected(box: Sandbox, args: string[], message: RegExp) {
  const res = await demo(box, ['trigger', ...args])
  assert.notEqual(res.code, 0, `expected failure for ${args.join(' ')}`)
  assert.match(res.stderr, message)
  // Validation happens before the run, and before the database, exist.
  assert.equal(existsSync(dbPath(box.stateRoot)), false)
}

type RunInput = {
  provider: string
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
    const approve = `pnpm demo approve --run ${waiting} --wait ${waitId}`
    const reject = `pnpm demo reject --run ${waiting} --wait ${waitId}`
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
