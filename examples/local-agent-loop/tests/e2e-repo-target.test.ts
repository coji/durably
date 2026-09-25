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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import {
  branchCommit,
  describeCommitChanges,
  resolveCommit,
  treeOf,
} from '../src/engine/git.js'
import { reportToJson, reportToMarkdown } from '../src/engine/report.js'
import { fixProfile } from '../src/factory/job.js'
import type { FactorySetup } from '../src/factory/types.js'
import { createTarget } from '../src/targets/index.js'

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

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

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

/** Commits from `from` (exclusive) to `to`, newest first, as author and message. */
async function commitsBetween(repo: string, from: string, to: string) {
  const out = await git(repo, [
    'log',
    '--format=%an <%ae>|%cn <%ce>|%s',
    `${from}..${to}`,
  ])
  return out
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
}

/**
 * A stand-in `gh` on PATH that logs each call. `pr list` answers with the
 * pull request once `pr create` has made it, as GitHub would.
 */
async function fakeGh(root: string): Promise<{ log: string; bin: string }> {
  const bin = join(root, 'bin')
  await mkdir(bin)
  const log = join(root, 'gh.log')
  const made = join(root, 'gh-pr-made')
  await writeFile(
    join(bin, 'gh'),
    [
      '#!/bin/sh',
      `echo "$*" >> "${log}"`,
      'case "$1 $2" in',
      `  "pr list") if [ -f "${made}" ]; then echo '[{"url":"https://example.invalid/pull/1"}]'; else echo '[]'; fi ;;`,
      `  "pr create") touch "${made}"; echo https://example.invalid/pull/1 ;;`,
      'esac',
      '',
    ].join('\n'),
  )
  await chmod(join(bin, 'gh'), 0o755)
  return { log, bin }
}

async function ghCalls(log: string, prefix: string): Promise<string[]> {
  if (!existsSync(log)) return []
  return (await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line.startsWith(prefix))
}

async function withBare(root: string, repo: string): Promise<string> {
  const remote = join(root, 'remote.git')
  await git(root, ['init', '--bare', '--initial-branch=main', remote])
  await git(repo, ['remote', 'add', 'origin', remote])
  await git(repo, ['push', 'origin', 'main'])
  return remote
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

      // Every candidate's diff and changed-file list sit outside the worktree
      // and match the recorded base commit and that candidate's commit.
      const report = await buildReport(durably, run.id)
      assert.equal(report.candidates.length, 2)
      const workdir = (await durably.getRun(run.id))?.output as {
        workdir: string
      }
      for (const c of report.candidates) {
        const changes = c.changes
        assert.ok(changes && c.commit, c.id)
        assert.ok(!changes.diffPath.startsWith(workdir.workdir))
        const expected = await runChild(
          'git',
          ['diff', '--binary', '--no-color', baseBefore, c.commit],
          { cwd: repo, timeoutMs: 30000, maxOutputChars: 10_000_000 },
        )
        assert.equal(await readFile(changes.diffPath, 'utf8'), expected.stdout)
        const list = (await describeCommitChanges(repo, baseBefore, c.commit))
          .map((line) => `${line}\n`)
          .join('')
        assert.equal(await readFile(changes.changedFilesPath, 'utf8'), list)
      }
      // The first iteration changed nothing; the repair changed calc.js.
      const [unchanged, repaired] = report.candidates
      assert.deepEqual(
        [
          unchanged?.changes?.files,
          unchanged?.changes?.additions,
          unchanged?.changes?.deletions,
        ],
        [0, 0, 0],
      )
      assert.equal(repaired?.changes?.files, 1)
      assert.ok((repaired?.changes?.additions ?? 0) > 0)
      assert.deepEqual(report.candidate?.changes, repaired?.changes)
      const md = reportToMarkdown(report)
      assert.ok(
        md.includes(`- iteration 1: ${unchanged?.id} — 0 files, +0 / -0 lines`),
      )
      assert.ok(md.includes(repaired?.changes?.diffPath ?? '?'))
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('fails a bad profile before creating a worktree or branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-bad-profile-'))
    const repo = await seedRepo(root)
    const stateRoot = join(root, 'state')
    const fake = fixProfile({ provider: 'fake', model: null, effort: null })
    const durably = createAgentDurably({ stateRoot })
    await durably.init()
    try {
      // A direct trigger that mixes fake and real roles; the CLI refuses this
      // before the run exists, so only setup can catch it here.
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        profiles: {
          code: fake,
          correctness: fake,
          'edge-cases': { ...fake, provider: 'codex' as const },
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
          publish: false,
        },
        maxIterations: 1,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'failed',
        60000,
        'bad-profile run fails',
      )
      const branches = await git(repo, ['branch', '--list', 'factory/*'])
      assert.equal(branches.trim(), '')
      assert.equal(existsSync(join(stateRoot, 'runs', run.id)), false)
    } finally {
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('names the candidate branch and commit when nothing is delivered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-unfixed-'))
    const repo = await seedRepo(root)
    // One iteration that leaves the bug: verification fails, no delivery.
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
        maxIterations: 1,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'unfixed run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        delivery: unknown
      }
      assert.equal(output.conclusion, 'verification-failed')
      assert.equal(output.delivery, null)

      const branch = `factory/${run.id}`
      const commit = await resolveCommit(repo, branch)
      // Nothing was delivered, so nothing was squashed.
      assert.equal(await branchCommit(repo, `factory/${run.id}-squashed`), null)
      const report = await buildReport(durably, run.id)
      assert.equal(report.candidate?.branch, branch)
      assert.equal(report.candidate?.commit, commit)
      for (const text of [reportToMarkdown(report), reportToJson(report)]) {
        assert.ok(text.includes(branch))
        assert.ok(text.includes(commit))
      }
      // A candidate stopped before review still has its size: here nothing
      // changed, so every count is zero.
      assert.equal(report.candidates.length, 1)
      assert.deepEqual(
        [
          report.candidate?.changes?.files,
          report.candidate?.changes?.additions,
          report.candidate?.changes?.deletions,
        ],
        [0, 0, 0],
      )
      assert.equal(
        await readFile(report.candidate?.changes?.diffPath ?? '', 'utf8'),
        '',
      )
      // The stop reason names the failing check's logs and exit code.
      const details = report.failure?.details ?? []
      assert.ok(details.includes('check exit code: 1'), details.join('\n'))
      const stdoutLine = details.find((d) => d.startsWith('check stdout log: '))
      const stdoutPath = stdoutLine?.slice('check stdout log: '.length) ?? ''
      assert.match(
        await readFile(stdoutPath, 'utf8'),
        /adds decimals without truncation/,
      )
      assert.ok(reportToMarkdown(report).includes(`- ${stdoutLine}`))
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
          // Effective values from the caller are ignored: setup resolves
          // them from the requested ones.
          code: {
            ...fixProfile(a),
            effectiveModel: 'forged',
            effectiveEffort: 'forged',
          } as ReturnType<typeof fixProfile>,
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
            task: { path: '/work/task.md' },
            spec: { path: '/work/spec.md' },
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
      const setupStep = (await durably.storage.getSteps(run.id)).find(
        (x) => x.name === 'setup',
      )?.output as { profiles: Record<string, { effectiveModel: string }> }
      assert.equal(setupStep.profiles['code']?.effectiveModel, 'fake-model')

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

      // Without commit settings: the factory's own author and messages, and
      // beside the iteration branch, one squashed commit on the base.
      const base = (
        await runChild('git', ['rev-parse', 'main'], {
          cwd: repo,
          timeoutMs: 30000,
        })
      ).stdout.trim()
      const factory = 'durably-factory <durably-factory@localhost>'
      assert.deepEqual(await commitsBetween(repo, base, branch), [
        `${factory}|${factory}|factory iteration 1`,
      ])
      const squashed = `factory/${run.id}-squashed`
      const squashedDelivery = output.delivery as typeof output.delivery & {
        squashedBranch: string | null
        squashedCommit: string | null
      }
      assert.equal(squashedDelivery.squashedBranch, squashed)
      assert.equal(
        squashedDelivery.squashedCommit,
        await branchCommit(repo, squashed),
      )
      assert.deepEqual(await commitsBetween(repo, base, squashed), [
        `${factory}|${factory}|factory run ${run.id}`,
      ])
      assert.equal(
        await treeOf(repo, squashed),
        await treeOf(repo, output.delivery.commit ?? ''),
      )

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
      // Hashed from the content the run stored, not taken from the caller.
      const taskHash = sha256('Fix add() so decimal inputs are not truncated.')
      assert.equal(report.inputs.task?.sha256, taskHash)
      assert.equal(
        report.inputs.spec?.sha256,
        sha256('add() returns the exact floating point sum.'),
      )
      assert.equal(report.inputs.dispositions, null)
      assert.equal(report.delivery?.branch, branch)
      assert.equal(report.delivery?.commit, output.delivery.commit)
      assert.equal(report.delivery?.squashedBranch, squashed)
      assert.equal(
        report.delivery?.squashedCommit,
        squashedDelivery.squashedCommit,
      )
      const md = reportToMarkdown(report)
      const json = reportToJson(report)
      for (const text of [md, json]) {
        assert.ok(text.includes(branch))
        assert.ok(text.includes(output.delivery.commit ?? 'missing'))
        assert.ok(text.includes(taskHash))
        assert.ok(text.includes(squashed))
        assert.doesNotMatch(text, /issue-\d|issues\/\d|#\d/)
      }
      assert.ok(md.includes(`- squashed branch: ${squashed}`))
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
    const remote = await withBare(root, repo)
    const gh = await fakeGh(root)
    const savedPath = process.env.PATH
    process.env.PATH = `${gh.bin}:${savedPath ?? ''}`
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
        delivery: {
          kind: string
          location: string
          branch: string | null
          squashedBranch: string | null
        }
      }
      assert.equal(output.delivery.kind, 'pull-request')
      assert.equal(output.delivery.location, 'https://example.invalid/pull/1')
      assert.equal(output.delivery.branch, `factory/${run.id}`)
      // The squashed branch is made, but publishSquashed is off: the
      // iteration branch is pushed and is the pull request's head.
      assert.equal(output.delivery.squashedBranch, `factory/${run.id}-squashed`)
      const calls = await ghCalls(gh.log, 'pr create')
      assert.equal(calls.length, 1)
      assert.match(calls[0] ?? '', new RegExp(`--head factory/${run.id} `))
      assert.ok(
        (await git(remote, ['branch', '--list', `factory/${run.id}`])).trim(),
      )
      assert.equal(
        (
          await git(remote, ['branch', '--list', `factory/${run.id}-squashed`])
        ).trim(),
        '',
      )
    } finally {
      process.env.PATH = savedPath
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })

  it('applies the commit settings to every commit, keeps the checkout, and pushes nothing without --publish', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-commit-'))
    const repo = await seedRepo(root)
    const remote = await withBare(root, repo)
    const gh = await fakeGh(root)
    const baseBefore = await resolveCommit(repo, 'HEAD')
    const savedPath = process.env.PATH
    process.env.PATH = `${gh.bin}:${savedPath ?? ''}`
    // Iteration 1 changes nothing and fails the check; iteration 2 fixes it.
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
          task: 'Fix add() for decimals\n\nInputs must not be truncated.',
          spec: null,
          dispositions: null,
          inputFiles: NO_FILES,
          issue: { number: 7, title: 'add truncates', url: 'https://x/7' },
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: false,
          commit: {
            authorName: 'Factory Bot',
            authorEmail: 'bot@example.com',
            messageTemplate: 'fix: {task} ({runId} #{iteration})',
            // Without --publish this pushes nothing.
            publishSquashed: true,
          },
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'commit-settings run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        conclusion: string
        iterations: number
        delivery: {
          kind: string
          branch: string
          commit: string
          squashedBranch: string
          squashedCommit: string
        }
      }
      assert.equal(output.conclusion, 'approved')
      assert.equal(output.iterations, 2)
      const bot = 'Factory Bot <bot@example.com>'
      const branch = `factory/issue-7-${run.id}`
      assert.equal(output.delivery.branch, branch)
      // The idle first iteration made no commit; the second is in the
      // template, by the configured author.
      assert.deepEqual(await commitsBetween(repo, baseBefore, branch), [
        `${bot}|${bot}|fix: Fix add() for decimals (${run.id} #2)`,
      ])
      // An issue run's squashed branch has the plain name, and its message
      // takes the iteration that sealed the last candidate.
      const squashed = `factory/${run.id}-squashed`
      assert.equal(output.delivery.squashedBranch, squashed)
      assert.deepEqual(await commitsBetween(repo, baseBefore, squashed), [
        `${bot}|${bot}|fix: Fix add() for decimals (${run.id} #2)`,
      ])
      assert.equal(
        (await git(repo, ['rev-parse', `${squashed}^`])).trim(),
        baseBefore,
      )
      assert.equal(
        await treeOf(repo, squashed),
        await treeOf(repo, output.delivery.commit),
      )
      // Nothing checked out moved, and nothing left the machine.
      assert.equal(await resolveCommit(repo, 'HEAD'), baseBefore)
      assert.equal(
        (await git(repo, ['symbolic-ref', '--short', 'HEAD'])).trim(),
        'main',
      )
      assert.equal(output.delivery.kind, 'patch')
      assert.equal(
        (await git(remote, ['branch', '--list', 'factory/*'])).trim(),
        '',
      )
      assert.deepEqual(await ghCalls(gh.log, ''), [])
    } finally {
      process.env.PATH = savedPath
      await durably.stop()
      await durably.db.destroy()
    }
  })

  it('publishes the squashed branch when asked, and a replayed delivery reuses its branch and pull request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-squash-pr-'))
    const repo = await seedRepo(root)
    const remote = await withBare(root, repo)
    const gh = await fakeGh(root)
    const savedPath = process.env.PATH
    process.env.PATH = `${gh.bin}:${savedPath ?? ''}`
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
          checkCommand: ['node', '--test', 'test/**/*.test.js'],
          setupCommand: null,
          publish: true,
          commit: {
            authorName: null,
            authorEmail: null,
            messageTemplate: null,
            publishSquashed: true,
          },
        },
        maxIterations: 2,
        context: 'reuse',
      })
      await waitFor(
        async () => (await durably.getRun(run.id))?.status === 'completed',
        150000,
        'squash-publish run completes',
      )
      const output = (await durably.getRun(run.id))?.output as {
        iterations: number
        candidate: Parameters<
          ReturnType<typeof createTarget>['deliver']
        >[0]['candidate']
        reviews: { lens: string; decision: string; notes: string }[]
        delivery: {
          kind: string
          location: string
          branch: string
          commit: string
          squashedBranch: string
          squashedCommit: string
        }
      }
      const squashed = `factory/${run.id}-squashed`
      assert.equal(output.delivery.kind, 'pull-request')
      assert.equal(output.delivery.location, 'https://example.invalid/pull/1')
      // The iteration branch is still what `branch` names; the squashed one
      // is what was pushed and opened.
      assert.equal(output.delivery.branch, `factory/${run.id}`)
      assert.equal(output.delivery.squashedBranch, squashed)
      const creates = await ghCalls(gh.log, 'pr create')
      assert.equal(creates.length, 1)
      assert.match(creates[0] ?? '', new RegExp(`--head ${squashed} `))
      assert.equal(
        (await git(remote, ['rev-parse', squashed])).trim(),
        output.delivery.squashedCommit,
      )
      assert.equal(
        (await git(remote, ['branch', '--list', `factory/${run.id}`])).trim(),
        '',
      )

      // The delivery step again, as after a crash between opening the pull
      // request and recording the step: the same commit, branch and pull
      // request, and no second `gh pr create`.
      const setup = (await durably.storage.getSteps(run.id)).find(
        (x) => x.name === 'setup',
      )?.output as FactorySetup
      const target = createTarget(setup.target)
      const deliver = () =>
        target.deliver({
          candidate: output.candidate,
          iteration: output.iterations,
          runId: run.id,
          reviews: output.reviews,
          signal: new AbortController().signal,
        })
      const replayed = await deliver()
      assert.equal(replayed.location, output.delivery.location)
      assert.equal(replayed.squashedCommit, output.delivery.squashedCommit)
      assert.equal(replayed.commit, output.delivery.commit)
      assert.equal(await branchCommit(repo, squashed), replayed.squashedCommit)
      assert.equal((await ghCalls(gh.log, 'pr create')).length, 1)

      // A branch by that name that is not this squash is never overwritten:
      // the delivery stops before pushing or opening anything.
      await git(repo, ['branch', '-f', squashed, 'main'])
      const listed = (await ghCalls(gh.log, '')).length
      await assert.rejects(deliver(), /already exists .* left as it is/)
      assert.equal(
        await branchCommit(repo, squashed),
        await resolveCommit(repo, 'main'),
      )
      assert.equal((await ghCalls(gh.log, '')).length, listed)
      assert.equal(
        (await git(remote, ['rev-parse', squashed])).trim(),
        output.delivery.squashedCommit,
      )
    } finally {
      process.env.PATH = savedPath
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })
})
