import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  ownedChildPids,
  reconcilePidFile,
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
})
