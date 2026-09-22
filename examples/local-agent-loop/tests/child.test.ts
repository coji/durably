import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  ownedChildPids,
  reconcilePidFile,
  reconcileRunPidFiles,
  runChild,
  SpawnCancelledError,
} from '../src/child.js'

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

  it('reconciles a stale pid marker without touching live processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reconcile-'))
    // Dead pid marker -> cleaned, nothing killed.
    const deadFile = join(dir, 'dead.json')
    await writeFile(deadFile, JSON.stringify({ pid: 99999999, startedAt: 'x' }))
    assert.equal(await reconcilePidFile(deadFile), 'clean')
    // Garbled marker -> removed, never signaled.
    const garbled = join(dir, 'garbled.json')
    await writeFile(garbled, 'not json')
    assert.equal(await reconcilePidFile(garbled), 'stale-marker-removed')
    // Pid-reuse guard: live pid with a mismatched start time is NOT killed.
    const liveFile = join(dir, 'live.json')
    await writeFile(
      liveFile,
      JSON.stringify({
        pid: process.pid,
        startedAt: 'definitely-not-the-start-time',
      }),
    )
    assert.equal(await reconcilePidFile(liveFile), 'clean')
    assert.ok(process.pid > 0, 'test process survived reconciliation')
  })

  it('reconciles pid markers under a runs root on worker start', async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'runs-'))
    await mkdir(join(runsRoot, 'run-a'), { recursive: true })
    // Stale marker (dead pid) is cleaned without killing anything.
    await writeFile(
      join(runsRoot, 'run-a', 'test-1.pid'),
      JSON.stringify({ pid: 99999999 }),
    )
    // Real residual: spawned directly (not via runChild) and left behind,
    // the way a kill -9ed worker would leave a test process.
    const residual = spawn('sleep', ['30'])
    assert.ok(residual.pid)
    const exited = new Promise((resolve) => residual.on('exit', resolve))
    await writeFile(
      join(runsRoot, 'run-a', 'test-2.pid'),
      JSON.stringify({ pid: residual.pid }),
    )
    const summary = await reconcileRunPidFiles(runsRoot)
    assert.equal(summary.checked, 2)
    assert.equal(summary.residualKilled, 1)
    await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('residual was not killed')), 10000),
      ),
    ])
  })

  it('treats a missing runs root as clean', async () => {
    const summary = await reconcileRunPidFiles(
      join(tmpdir(), 'runs-missing-root'),
    )
    assert.deepEqual(summary, { checked: 0, cleaned: 0, residualKilled: 0 })
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
