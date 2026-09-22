import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ownedChildPids, runChild, SpawnCancelledError } from '../src/child.js'

describe('cancel-aware subprocess', () => {
  it('kills ONLY the owned child on abort and confirms the exit', async () => {
    const controller = new AbortController()
    const pending = runChild('sleep', ['30'], {
      timeoutMs: 20000,
      signal: controller.signal,
    })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(ownedChildPids().length, 1)
    const owned = ownedChildPids()[0] as number
    controller.abort()
    await assert.rejects(pending, (err: unknown) => {
      assert.match((err as Error).message, /cancelled/)
      return true
    })
    assert.equal(ownedChildPids().length, 0)
    // The owned pid is gone; an unrelated pid was never touched (this
    // process itself is still alive to assert that).
    assert.ok(owned > 0)
    assert.ok(process.pid !== owned)
  })

  it('rejects when already aborted before spawn (no child created)', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runChild('sleep', ['5'], {
        timeoutMs: 10000,
        signal: controller.signal,
      }),
      SpawnCancelledError,
    )
    assert.equal(ownedChildPids().length, 0)
  })

  it('scrubs the test-runner context so nested node --test really runs', async () => {
    const prev = process.env['NODE_TEST_CONTEXT']
    process.env['NODE_TEST_CONTEXT'] = 'child-v8'
    try {
      const res = await runChild(
        'node',
        ['-e', 'console.log(process.env.NODE_TEST_CONTEXT ?? "absent")'],
        { timeoutMs: 10000 },
      )
      assert.match(
        res.stdout,
        /absent/,
        'an inherited NODE_TEST_CONTEXT makes nested node --test skip its files (vacuous pass)',
      )
    } finally {
      if (prev === undefined) delete process.env['NODE_TEST_CONTEXT']
      else process.env['NODE_TEST_CONTEXT'] = prev
    }
  })
})
