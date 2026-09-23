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
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createAgentDurably } from '../src/durably.js'
import { runChild } from '../src/engine/child.js'
import { resolveCommit } from '../src/engine/git.js'

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

async function git(cwd: string, args: string[]): Promise<void> {
  const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
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

    process.env.DURABLY_DB = join(root, 'factory.db')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    delete process.env.FAKE_REVIEW_SLOW_MS

    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
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
      delete process.env.DURABLY_DB
      delete process.env.FAKE_FAIL_FIRST
    }
  })

  it('seals each iteration as its own candidate and repairs from feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-repair-'))
    const repo = await seedRepo(root)
    const baseBefore = await resolveCommit(repo, 'HEAD')

    process.env.DURABLY_DB = join(root, 'factory.db')
    // Iteration 1 leaves the bug in place, so verification fails and the loop
    // repairs. The first candidate therefore seals content identical to the
    // base: an iteration that did no work must not look like progress.
    delete process.env.FAKE_FAIL_FIRST
    delete process.env.FAKE_REVIEW_SEQUENCE

    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
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
      delete process.env.DURABLY_DB
    }
  })

  it('survives a check that leaves untracked build output behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repo-target-dirty-'))
    const repo = await seedRepo(root)

    process.env.DURABLY_DB = join(root, 'factory.db')
    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE

    const durably = createAgentDurably()
    await durably.init()
    try {
      const run = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Fix add() so decimal inputs are not truncated.',
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
      delete process.env.DURABLY_DB
      delete process.env.FAKE_FAIL_FIRST
    }
  })
})
