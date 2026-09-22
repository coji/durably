import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { runChild } from '../src/engine/child.js'
import {
  addWorktree,
  commitAll,
  describeCommitChanges,
  isDirty,
  discardWorktree,
  writePatch,
  readFileAt,
  removeWorktree,
  repoRoot,
  resolveCommit,
  treeOf,
} from '../src/engine/git.js'

let root = ''
let repo = ''
let base = ''

async function git(cwd: string, args: string[]): Promise<void> {
  const res = await runChild('git', args, { cwd, timeoutMs: 30000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
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
})
