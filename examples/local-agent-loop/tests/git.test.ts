import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runChild } from '../src/engine/child.js'
import {
  addWorktree,
  branchCommit,
  commitAll,
  DEFAULT_COMMIT_AUTHOR,
  ensureSquashedBranch,
  describeCommitChanges,
  diffStat,
  isDirty,
  discardWorktree,
  writePatch,
  readFileAt,
  removeWorktree,
  repoRoot,
  resolveCommit,
  treeOf,
} from '../src/engine/git.js'
import { renderCommitMessage, squashedBranchFor } from '../src/targets/repo.js'

let root = ''
let repo = ''
let base = ''

async function git(cwd: string, args: string[]): Promise<string> {
  const res = await runChild('git', args, { cwd, timeoutMs: 30000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout
}

/** Author, committer and message of one commit. */
async function commitInfo(commit: string) {
  const [author, committer, ...message] = (
    await git(repo, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B', commit])
  ).split('\n')
  return { author, committer, message: message.join('\n').trim() }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-engine-'))
  repo = join(root, 'repo')
  await git(root, ['init', '--initial-branch=main', 'repo'])
  await git(repo, ['config', 'user.email', 'test@localhost'])
  await git(repo, ['config', 'user.name', 'test'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await writeFile(join(repo, '.gitignore'), 'ignored/\n')
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'base'])
  base = await resolveCommit(repo, 'HEAD')
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('git engine', () => {
  it('resolves the repository root and a commit tree', async () => {
    // git reports the real path; on macOS /var is a symlink to /private/var.
    assert.equal(await repoRoot(repo), await realpath(repo))
    const tree = await treeOf(repo, base)
    assert.match(tree, /^[0-9a-f]{40}$/)
    // The tree is content identity: an empty commit keeps it unchanged.
    assert.equal(await treeOf(repo, base), tree)
  })

  it('seals work in an isolated worktree without touching the checkout', async () => {
    const wt = join(root, 'wt-1')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/1' })
    assert.equal(await isDirty(wt), false)
    await writeFile(join(wt, 'a.txt'), 'two\n')
    await writeFile(join(wt, 'b.txt'), 'new\n')
    assert.equal(await isDirty(wt), true)

    const sealed = await commitAll(wt, 'iteration 1')
    assert.equal(sealed.created, true)
    assert.equal(await isDirty(wt), false)
    // The original checkout never moved.
    assert.equal(await resolveCommit(repo, 'HEAD'), base)
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\n')

    const changes = await describeCommitChanges(repo, base, sealed.commit)
    assert.deepEqual(changes.sort(), ['added: b.txt', 'modified: a.txt'])
    assert.equal(await readFileAt(repo, sealed.commit, 'a.txt'), 'two\n')
    assert.equal(await readFileAt(repo, sealed.commit, 'absent.txt'), null)

    const patchPath = join(root, 'sealed.patch')
    await writePatch(repo, base, sealed.commit, patchPath)
    const patch = await readFile(patchPath, 'utf8')
    assert.match(patch, /diff --git a\/a\.txt b\/a\.txt/)
    assert.match(patch, /\+two/)

    assert.equal(await removeWorktree(repo, wt), true)
  })

  it('reports no commit when the agent changed nothing', async () => {
    const wt = join(root, 'wt-2')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/2' })
    // An iteration that produced nothing must seal the same content rather
    // than an empty commit that looks like progress.
    const sealed = await commitAll(wt, 'iteration 1')
    assert.equal(sealed.created, false)
    assert.equal(await treeOf(repo, sealed.commit), await treeOf(repo, base))
    await removeWorktree(repo, wt)
  })

  it('honours .gitignore when sealing', async () => {
    const wt = join(root, 'wt-3')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/3' })
    await writeFile(join(wt, 'kept.txt'), 'kept\n')
    await runChild('mkdir', ['-p', join(wt, 'ignored')], { timeoutMs: 10000 })
    await writeFile(join(wt, 'ignored', 'junk.txt'), 'junk\n')
    const sealed = await commitAll(wt, 'iteration 1')
    const changes = await describeCommitChanges(repo, base, sealed.commit)
    assert.deepEqual(changes, ['added: kept.txt'])
    await removeWorktree(repo, wt)
  })

  it('surfaces git failures instead of returning empty output', async () => {
    await assert.rejects(resolveCommit(repo, 'no-such-ref'), /failed with code/)
  })

  it('writes a large patch whole instead of truncating it', async () => {
    const wt = join(root, 'wt-big')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/big' })
    // Well past the captured-output cap. A patch truncated from the front
    // still looks like a patch, and `git apply` rejects it with nothing to
    // say why, so the whole diff has to reach disk.
    const lines: string[] = []
    for (let i = 0; i < 40_000; i++) lines.push(`line ${i} ${'x'.repeat(40)}`)
    await writeFile(join(wt, 'big.txt'), `${lines.join('\n')}\n`)
    const sealed = await commitAll(wt, 'big')
    const patchPath = join(root, 'big.patch')
    await writePatch(repo, base, sealed.commit, patchPath)
    const patch = await readFile(patchPath, 'utf8')
    assert.ok(patch.length > 1_500_000, `patch was ${patch.length} bytes`)
    assert.match(patch.split('\n')[0] ?? '', /^diff --git /)
    assert.match(patch, /\+line 39999 /)
    await removeWorktree(repo, wt)
  })

  it('ignores untracked files when asked, so build output is not a mutation', async () => {
    const wt = join(root, 'wt-untracked')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/unt' })
    await writeFile(join(wt, 'build-output.txt'), 'generated by the check\n')
    assert.equal(await isDirty(wt), true)
    // The sealed candidate names a commit; a file git does not track cannot
    // be part of it, so integrity checking must not see this.
    assert.equal(await isDirty(wt, { includeUntracked: false }), false)
    await removeWorktree(repo, wt)
  })

  it('discards a worktree and branch so preparation can be replayed', async () => {
    const wt = join(root, 'wt-replay')
    const branch = 'work/replay'
    await addWorktree({ repo, dir: wt, baseCommit: base, branch })
    // A worker killed during setup re-runs it; `git worktree add -b` refuses
    // a directory and branch that already exist.
    await discardWorktree(repo, wt, branch)
    await addWorktree({ repo, dir: wt, baseCommit: base, branch })
    assert.equal(await isDirty(wt), false)
    // Discarding twice, or discarding what was never created, is a no-op.
    await discardWorktree(repo, wt, branch)
    await discardWorktree(repo, join(root, 'never-made'), 'work/never')
  })

  it('counts a change by files and text lines, renames and binaries included', async () => {
    const wt = join(root, 'wt-stat')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/stat' })
    // Nothing changed yet: every count is zero.
    assert.deepEqual(await diffStat(repo, base, base), {
      files: 0,
      additions: 0,
      deletions: 0,
    })
    const body = Array.from({ length: 20 }, (_, i) => `row ${i}`).join('\n')
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\n')
    await writeFile(join(wt, 'with space\tand tab.txt'), 'x\ny\n')
    await writeFile(join(wt, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
    await writeFile(join(wt, 'moved-from.txt'), `${body}\n`)
    await commitAll(wt, 'stage')
    const mid = await resolveCommit(wt, 'HEAD')
    await rename(join(wt, 'moved-from.txt'), join(wt, 'moved to.txt'))
    const sealed = await commitAll(wt, 'rename')
    // a.txt: +2 (one kept), the spaced file +2, the binary adds no lines.
    assert.deepEqual(await diffStat(repo, base, mid), {
      files: 4,
      additions: 2 + 2 + 20,
      deletions: 0,
    })
    // A pure rename is one file with no line changes.
    assert.deepEqual(await diffStat(repo, mid, sealed.commit), {
      files: 1,
      additions: 0,
      deletions: 0,
    })
    const renamed = await describeCommitChanges(repo, mid, sealed.commit)
    assert.deepEqual(renamed, ['renamed: moved-from.txt -> moved to.txt'])
    await removeWorktree(repo, wt)
  })

  it('lists every changed file even past the captured-output cap', async () => {
    const wt = join(root, 'wt-many')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/many' })
    // Each `A\0<path>\0` record is about 240 characters, so 4,300 of them
    // run past the 1,000,000-character cap a git call captures by default.
    const dir = join(wt, 'many')
    await mkdir(dir)
    const count = 4300
    const names = Array.from(
      { length: count },
      (_, i) => `f${String(i).padStart(5, '0')}-${'n'.repeat(220)}.txt`,
    )
    for (const name of names) await writeFile(join(dir, name), 'x\n')
    const sealed = await commitAll(wt, 'many')
    const changes = await describeCommitChanges(repo, base, sealed.commit)
    assert.ok(changes.join('\0').length > 1_000_000)
    assert.equal(changes.length, count)
    assert.equal(changes.at(-1), `added: many/${names.at(-1)}`)
    assert.deepEqual(await diffStat(repo, base, sealed.commit), {
      files: count,
      additions: count,
      deletions: 0,
    })
    await removeWorktree(repo, wt)
  })

  it('commits as the given author, and as durably-factory without one', async () => {
    const wt = join(root, 'wt-author')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/au' })
    await writeFile(join(wt, 'a.txt'), 'by default\n')
    const plain = await commitAll(wt, 'factory iteration 1')
    assert.deepEqual(await commitInfo(plain.commit), {
      author: `${DEFAULT_COMMIT_AUTHOR.name} <${DEFAULT_COMMIT_AUTHOR.email}>`,
      committer: `${DEFAULT_COMMIT_AUTHOR.name} <${DEFAULT_COMMIT_AUTHOR.email}>`,
      message: 'factory iteration 1',
    })
    await writeFile(join(wt, 'a.txt'), 'by the bot\n')
    const named = await commitAll(wt, 'fix: add (iteration 2)', {
      author: { name: 'Factory Bot', email: 'bot@example.com' },
    })
    assert.deepEqual(await commitInfo(named.commit), {
      author: 'Factory Bot <bot@example.com>',
      committer: 'Factory Bot <bot@example.com>',
      message: 'fix: add (iteration 2)',
    })
    // Nothing changed: no commit, whoever the author would have been.
    const idle = await commitAll(wt, 'unused', {
      author: { name: 'Factory Bot', email: 'bot@example.com' },
    })
    assert.equal(idle.created, false)
    assert.equal(idle.commit, named.commit)
    await removeWorktree(repo, wt)
  })

  it('squashes a candidate into one commit on the base, once, without moving any checkout', async () => {
    const wt = join(root, 'wt-squash')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/sq' })
    await writeFile(join(wt, 'a.txt'), 'first\n')
    await commitAll(wt, 'iteration 1')
    await writeFile(join(wt, 'c.txt'), 'second\n')
    const last = await commitAll(wt, 'iteration 2')
    const author = { name: 'Factory Bot', email: 'bot@example.com' }
    const spec = {
      repo,
      branch: 'work/sq-squashed',
      baseCommit: base,
      sourceCommit: last.commit,
      message: 'fix: everything at once',
      author,
    }
    const made = await ensureSquashedBranch(spec)
    assert.equal(made.created, true)
    assert.equal(await branchCommit(repo, spec.branch), made.commit)
    // Exactly one commit on the base, carrying the candidate's tree.
    assert.equal(
      (
        await git(repo, ['rev-list', '--count', `${base}..${spec.branch}`])
      ).trim(),
      '1',
    )
    assert.equal(
      (await git(repo, ['rev-parse', `${made.commit}^`])).trim(),
      base,
    )
    assert.equal(
      await treeOf(repo, made.commit),
      await treeOf(repo, last.commit),
    )
    assert.deepEqual(await commitInfo(made.commit), {
      author: 'Factory Bot <bot@example.com>',
      committer: 'Factory Bot <bot@example.com>',
      message: 'fix: everything at once',
    })
    // The iteration branch keeps both commits; nothing checked out moved.
    assert.equal(
      (await git(repo, ['rev-list', '--count', `${base}..work/sq`])).trim(),
      '2',
    )
    assert.equal(await resolveCommit(repo, 'HEAD'), base)
    assert.equal(await resolveCommit(wt, 'HEAD'), last.commit)
    assert.equal(await isDirty(wt), false)

    // Run again, as a replayed delivery would: the same branch and commit.
    const again = await ensureSquashedBranch(spec)
    assert.deepEqual(again, { commit: made.commit, created: false })
    // Dated from the source commit, so building it anew gives the same sha.
    await git(repo, ['branch', '-D', spec.branch])
    const rebuilt = await ensureSquashedBranch(spec)
    assert.deepEqual(rebuilt, { commit: made.commit, created: true })
    await removeWorktree(repo, wt)
  })

  it('gives a candidate with the base tree its own single commit', async () => {
    const made = await ensureSquashedBranch({
      repo,
      branch: 'work/empty-squashed',
      baseCommit: base,
      sourceCommit: base,
      message: 'factory run empty',
      author: DEFAULT_COMMIT_AUTHOR,
    })
    assert.notEqual(made.commit, base)
    assert.equal(await treeOf(repo, made.commit), await treeOf(repo, base))
    assert.equal(
      (
        await git(repo, ['rev-list', '--count', `${base}..work/empty-squashed`])
      ).trim(),
      '1',
    )
  })

  it('refuses an existing branch that is not the same squash, and leaves it', async () => {
    const wt = join(root, 'wt-clash')
    await addWorktree({ repo, dir: wt, baseCommit: base, branch: 'work/cl' })
    await writeFile(join(wt, 'a.txt'), 'one change\n')
    const one = await commitAll(wt, 'iteration 1')
    await writeFile(join(wt, 'd.txt'), 'another\n')
    const two = await commitAll(wt, 'iteration 2')
    const spec = {
      repo,
      baseCommit: base,
      sourceCommit: two.commit,
      message: 'squash',
      author: DEFAULT_COMMIT_AUTHOR,
    }
    // Two commits on the base, though the tip has the right tree.
    await git(repo, ['branch', 'work/cl-two', two.commit])
    await assert.rejects(
      ensureSquashedBranch({ ...spec, branch: 'work/cl-two' }),
      /already exists .* left as it is/,
    )
    assert.equal(await branchCommit(repo, 'work/cl-two'), two.commit)
    // One commit on the base, with another tree.
    await git(repo, ['branch', 'work/cl-other', one.commit])
    await assert.rejects(
      ensureSquashedBranch({ ...spec, branch: 'work/cl-other' }),
      /already exists/,
    )
    assert.equal(await branchCommit(repo, 'work/cl-other'), one.commit)
    await removeWorktree(repo, wt)
  })

  it('fills a message template once, with the first line of the task', () => {
    const values = {
      iteration: 2,
      runId: 'run-9',
      task: '\n  Fix add() for {runId} inputs  \n\nMore detail {iteration}.\n',
    }
    assert.equal(
      renderCommitMessage('fix: {task} [{runId}#{iteration}] {other}', values),
      'fix: Fix add() for {runId} inputs [run-9#2] {other}',
    )
    assert.equal(squashedBranchFor('run-9'), 'factory/run-9-squashed')
  })
})
