import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  hashDir,
  snapshotAcceptance,
  verifyAcceptanceIntact,
} from '../src/acceptance.js'

async function seed(dir: string, files: Record<string, string>) {
  const { mkdir } = await import('node:fs/promises')
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
}

describe('immutable acceptance tests', () => {
  it('snapshots pristine tests and detects workdir tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accept-'))
    const pristine = join(root, 'pristine')
    const snapDir = join(root, 'snap')
    const work = join(root, 'work')
    await seed(pristine, { 'calc.test.js': 'assert(add(0.1,0.2))\n' })
    const snap = await snapshotAcceptance(pristine, snapDir)
    assert.equal(snap.files, 1)
    await seed(work, { 'calc.test.js': 'assert(add(0.1,0.2))\n' })
    const ok = await verifyAcceptanceIntact(work, snap.hash)
    assert.equal(ok.hash, snap.hash)
    // Agent edits a test to force green -> tamper error, not a pass.
    await seed(work, { 'calc.test.js': 'assert(true) // edited\n' })
    await assert.rejects(
      verifyAcceptanceIntact(work, snap.hash),
      /acceptance-tampered/,
    )
  })

  it('hashDir is order-stable and content-sensitive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hash-'))
    const a = join(root, 'a')
    await seed(a, { 'x.js': '1', 'y.js': '2' })
    const h1 = await hashDir(a)
    const h2 = await hashDir(a)
    assert.equal(h1, h2)
    await seed(a, { 'y.js': '3' })
    assert.notEqual(await hashDir(a), h1)
  })
})
