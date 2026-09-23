/**
 * Fake-mode end-to-end against a real git repository.
 *
 * Proves the part that makes the factory usable on actual work: the agent
 * edits an isolated worktree, each iteration is sealed as a commit, grading
 * runs the check that was pinned before the agent started, and the human
 * receives a patch against the recorded base. The checkout the repository
 * owner is sitting in must never move.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import { resolveCommit } from '../src/engine/git.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import { fixProfile } from '../src/factory/job.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const BUGGY = `export function add(a, b) {
  return Math.trunc(a) + Math.trunc(b)
}

export function mul(a, b) {
  return a * b
}
`

const SUITE = `import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { add } from '../src/calc.js'

describe('calc', () => {
  it('adds decimals without truncation', () => {
    assert.equal(add(0.1, 0.2), 0.30000000000000004)
  })
})
`

const NO_FILES = { task: null, spec: null, dispositions: null }

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

async function seedRepo(root: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'test'), { recursive: true })
  await writeFile(join(repo, 'src', 'calc.js'), BUGGY)
  await writeFile(join(repo, 'test', 'calc.test.js'), SUITE)
  await writeFile(join(repo, 'package.json'), '{"type":"module"}\n')
  await git(root, ['init', '--initial-branch=main', 'repo'])
  await git(repo, ['config', 'user.email', 'test@localhost'])
  await git(repo, ['config', 'user.name', 'test'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'seed'])
  return repo
}

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

describe('repo target end to end', { timeout: 180000 }, () => {
  it('works an isolated worktree and delivers a patch against the base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-'))
    const repo = await seedRepo(root)
    const baseBefore = await resolveCommit(repo, 'HEAD')

    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_REVIEW_SLOW_MS

    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
          spec: null,
          dispositions: null,
          inputFiles: NO_FILES,
          issue: null,
          // Pinned before the agent starts: nothing it edits can change this.
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: false,
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'repo run completes',
      )
      const finished = await durably.getRun(run.id)
      const output = finished?.output as {
        approved: boolean
        conclusion: string
        delivery: { kind: string; location: string } | null
        workdir: string
      }
      assert.equal(output.conclusion, 'approved')
      assert.equal(output.approved, true)

      // No approval signal was sent: a repository target delivers something
      // the human reviews, so it does not also wait for a separate approval.
      assert.deepEqual(await durably.getWaits(run.id), [])

      assert.equal(output.delivery?.kind, 'patch')
      const patchPath = output.delivery?.location ?? ''
      assert.ok(existsSync(patchPath), `patch missing at ${patchPath}`)
      const patch = await readFile(patchPath, 'utf8')
      assert.match(patch, /-\s*return Math\.trunc\(a\) \+ Math\.trunc\(b\)/)
      assert.match(patch, /\+\s*return a \+ b/)

      // The owner's checkout never moved, and still holds the original bug.
      assert.equal(await resolveCommit(repo, 'HEAD'), baseBefore)
      assert.match(
        await readFile(join(repo, 'src', 'calc.js'), 'utf8'),
        /Math\.trunc/,
      )

      // The work happened in a worktree, not in the repository itself.
      assert.notEqual(output.workdir, repo)
      assert.match(
        await readFile(join(output.workdir, 'src', 'calc.js'), 'utf8'),
        /return a \+ b/,
      )
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })

  it('seals each iteration as its own candidate and repairs from feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-repair-'))
    const repo = await seedRepo(root)
    const baseBefore = await resolveCommit(repo, 'HEAD')

    // Iteration 1 leaves the bug in place, so verification fails and the loop
    // repairs. The first candidate therefore seals content identical to the
    // base: an iteration that did no work must not look like progress.
    delete process.env.FAKE_FAIL_FIRST
    delete process.env.FAKE_REVIEW_SEQUENCE

    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
          spec: null,
          dispositions: null,
          inputFiles: NO_FILES,
          issue: null,
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: false,
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'repair run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        iterations: number
        candidate: { id: string; sourceHash: string } | null
      }
      assert.equal(output.conclusion, 'approved')
      assert.equal(output.iterations, 2)

      // Two distinct candidates were sealed, and the approved one is not the
      // base tree the failed first iteration produced.
      const attempts = await durably.getStepAttempts(run.id)
      const sealed = attempts.filter((a) => a.stepName.endsWith(':candidate'))
      assert.equal(sealed.length, 2)
      const baseTree = (
        await runChild('git', ['rev-parse', `${baseBefore}^{tree}`], {
          cwd: repo,
          timeoutMs: 30000,
        })
      ).stdout.trim()
      assert.notEqual(output.candidate?.sourceHash, baseTree)
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('survives a check that leaves untracked build output behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-dirty-'))
    const repo = await seedRepo(root)

    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE

    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
          spec: null,
          dispositions: null,
          inputFiles: NO_FILES,
          issue: null,
          // Real checks write build output: .turbo/, *.tsbuildinfo, coverage.
          // None of it is in the commit the candidate names, so a passing
          // check must not read as "the candidate changed under us".
          checkCommand: [
            'sh',
            '-c',
            'node --test test/**/*.test.js; code=$?; echo built > build-output.txt; exit $code',
          ],
          setupCommand: null,
          publish: false,
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'dirty-check run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        workdir: string
      }
      assert.equal(output.conclusion, 'approved')
      assert.ok(existsSync(join(output.workdir, 'build-output.txt')))
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })

  it('runs each role on its own profile and delivers an issue-free branch and commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-roles-'))
    const repo = await seedRepo(root)
    const stateRoot = join(root, 'state')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE

    const a = { provider: 'fake' as const, model: 'model-a', effort: 'low' }
    const b = { provider: 'fake' as const, model: 'model-b', effort: 'high' }
    const durably = createAgentDurably({ stateRoot })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: fixProfile(a),
          correctness: fixProfile(a),
          'edge-cases': fixProfile(b),
        },
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
          spec: 'add() returns the exact floating point sum.',
          dispositions: null,
          inputFiles: {
            task: { path: '/work/task.md', sha256: 'a'.repeat(64) },
            spec: { path: '/work/spec.md', sha256: 'b'.repeat(64) },
            dispositions: null,
          },
          issue: null,
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: false,
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'role-profile run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        workdir: string
        delivery: {
          kind: string
          location: string
          summary: string
          branch: string | null
          commit: string | null
        }
      }
      assert.equal(output.conclusion, 'approved')

      // Each LLM call carried its own role's requested settings.
      const attempts = await durably.getStepAttempts(run.id)
      const requested = (suffix: string) =>
        attempts
          .filter((x) => x.stepName.endsWith(suffix))
          .map(
            (x) => (x.metadata as { requestedModel?: string }).requestedModel,
          )
      assert.deepEqual([...new Set(requested(':agent'))], ['model-a'])
      assert.deepEqual([...new Set(requested(':correctness'))], ['model-a'])
      assert.deepEqual([...new Set(requested(':edge-cases'))], ['model-b'])

      // Issue-free naming: the branch is factory/<runId> and carries the
      // delivered commit; nothing the factory wrote names an issue.
      const branch = `factory/${run.id}`
      assert.equal(output.delivery.kind, 'patch')
      assert.equal(output.delivery.branch, branch)
      assert.equal(output.delivery.commit, await resolveCommit(repo, branch))
      const messages = await git(repo, [
        'log',
        '--format=%B',
        `HEAD..${branch}`,
      ])
      assert.ok(messages.trim().length > 0)
      assert.doesNotMatch(messages, /issue|#\d/i)
      assert.doesNotMatch(basename(output.delivery.location), /issue/i)
      assert.doesNotMatch(output.delivery.summary, /issue|#\d/i)
      assert.doesNotMatch(branch, /issue/)

      // The report splits the roles and names the inputs and the delivery.
      const report = await buildReport(durably, run.id)
      assert.deepEqual(
        report.roleUsage.map((r) => [
          r.role,
          r.provider,
          r.requestedModel,
          r.requestedEffort,
        ]),
        [
          ['code', 'fake', 'model-a', 'low'],
          ['correctness', 'fake', 'model-a', 'low'],
          ['edge-cases', 'fake', 'model-b', 'high'],
        ],
      )
      for (const role of report.roleUsage) {
        assert.ok(role.invocations > 0, role.role)
        // Fake calls report no usage: unknown, never zero.
        assert.equal(role.totalTokens, null, role.role)
        assert.equal(role.complete, false, role.role)
      }
      assert.equal(report.inputs.task?.sha256, 'a'.repeat(64))
      assert.equal(report.inputs.spec?.sha256, 'b'.repeat(64))
      assert.equal(report.inputs.dispositions, null)
      assert.equal(report.delivery?.branch, branch)
      assert.equal(report.delivery?.commit, output.delivery.commit)
      const md = reportToMarkdown(report)
      const json = reportToJson(report)
      for (const text of [md, json]) {
        assert.ok(text.includes(branch))
        assert.ok(text.includes(output.delivery.commit ?? 'missing'))
        assert.ok(text.includes('a'.repeat(64)))
        assert.doesNotMatch(text, /issue-\d|issues\/\d|#\d/)
      }
      assert.match(md, /\| edge-cases \| fake \| model-b \| high \| \d+ \|/)
      assert.match(md, /\| correctness \| fake \| model-a \| low \| \d+ \|/)

      // Every piece of run data is under the state root: nothing in the
      // repository and nothing in the checkout.
      const runDir = join(stateRoot, 'runs', run.id)
      assert.ok(output.workdir.startsWith(runDir), output.workdir)
      assert.ok(output.delivery.location.startsWith(runDir))
      assert.ok(existsSync(join(runDir, 'operation-checkpoints')))
      // Verification scratch is derived from the checkpoint directory, so it
      // lands beside it; the repo target grades in its worktree and needs none.
      assert.equal(existsSync(join(repo, 'runs')), false)
      assert.deepEqual(
        readdirSync(repo).filter((name) => name.endsWith('.db')),
        [],
      )
      assert.equal(existsSync(join(packageRoot, 'runs', run.id)), false)
    } finally {
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })

  it('opens the draft pull request exactly once when publishing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-publish-'))
    const repo = await seedRepo(root)
    const remote = join(root, 'remote.git')
    await git(root, ['init', '--bare', '--initial-branch=main', remote])
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', 'origin', 'main'])
    // A stand-in `gh` that records each call instead of reaching GitHub.
    const bin = join(root, 'bin')
    await mkdir(bin)
    const ghLog = join(root, 'gh.log')
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh\necho "$*" >> "${ghLog}"\necho https://example.invalid/pull/1\n`,
    )
    await chmod(join(bin, 'gh'), 0o755)
    const savedPath = process.env.PATH
    process.env.PATH = `${bin}:${savedPath ?? ''}`
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE

    const durably = createAgentDurably({ stateRoot: join(root, 'state') })
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: fixProfile({
            provider: 'fake',
            model: 'model-a',
            effort: null,
          }),
          correctness: fixProfile({
            provider: 'fake',
            model: 'model-b',
            effort: null,
          }),
          'edge-cases': fixProfile({
            provider: 'fake',
            model: 'model-c',
            effort: null,
          }),
        },
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
          spec: null,
          dispositions: null,
          inputFiles: NO_FILES,
          issue: null,
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: true,
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'publish run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        delivery: { kind: string; location: string; branch: string | null }
      }
      assert.equal(output.delivery.kind, 'pull-request')
      assert.equal(output.delivery.location, 'https://example.invalid/pull/1')
      assert.equal(output.delivery.branch, `factory/${run.id}`)
      const calls = (await readFile(ghLog, 'utf8'))
        .split('\n')
        .filter((line) => line.startsWith('pr create'))
      assert.equal(calls.length, 1)
      assert.ok(
        (await git(remote, ['branch', '--list', `factory/${run.id}`])).trim(),
      )
    } finally {
      process.env.PATH = savedPath
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })
})
