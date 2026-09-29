/**
 * `cleanupSpecWriteSiblings` sweeps files a spec writer left beside the
 * spec file, without ever letting the sweep's own failure replace or hide
 * the writer call's error, and without failing a step whose call already
 * succeeded.
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { cleanupSpecWriteSiblings } from '../src/factory/stages.js'

/** A spec directory with the spec file and one sibling to sweep. */
async function seedSpecDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'spec-cleanup-'))
  await writeFile(join(dir, 'spec.md'), 'spec content\n')
  await writeFile(join(dir, 'extra.txt'), 'left beside the spec\n')
  return dir
}

describe('cleanupSpecWriteSiblings', () => {
  it('removes siblings and reports no warning when the call succeeded and cleanup succeeds', async () => {
    const dir = await seedSpecDir()
    const result = await cleanupSpecWriteSiblings(join(dir, 'spec.md'))
    assert.deepEqual(result, { removed: ['extra.txt'], cleanupWarning: null })
  })

  it('reports a cleanupWarning, not a throw, when the call succeeded but cleanup fails', async () => {
    const dir = await seedSpecDir()
    // Deny read on the spec directory so `removeBesideSpec`'s `readdir`
    // fails with something other than ENOENT.
    await chmod(dir, 0o000)
    try {
      const result = await cleanupSpecWriteSiblings(join(dir, 'spec.md'))
      assert.equal(result.removed.length, 0)
      assert.match(result.cleanupWarning ?? '', /spec\.md/)
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it('rethrows the call error unchanged when the call failed, even if cleanup also fails', async () => {
    const dir = await seedSpecDir()
    await chmod(dir, 0o000)
    const callError = new Error('the writer call failed')
    try {
      await assert.rejects(
        cleanupSpecWriteSiblings(join(dir, 'spec.md'), callError),
        (error: unknown) => error === callError,
      )
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it('rethrows the call error unchanged when the call failed and cleanup succeeds', async () => {
    const dir = await seedSpecDir()
    const callError = new Error('the writer call failed')
    await assert.rejects(
      cleanupSpecWriteSiblings(join(dir, 'spec.md'), callError),
      (error: unknown) => error === callError,
    )
  })
})
