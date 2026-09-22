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
  patchBetween,
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

    const patch = await patchBetween(repo, base, sealed.commit)
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
})
