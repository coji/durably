import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { describe, it } from 'node:test'

import {
  ownedChildPids,
  runChild,
  SpawnCancelledError,
  teeLog,
} from '../src/engine/child.js'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out: ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks the condition until its deadline
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('cancel-aware subprocess', () => {
  it('kills ONLY the owned child on abort and confirms the exit', async () => {
    const controller = new AbortController()
    const pending = runChild('sleep', ['30'], {
      timeoutMs: 20000,
      signal: controller.signal,
    })
    // runChild registers the pid and its abort listener synchronously once
    // spawn() returns, so the child is live and owned before the abort.
    assert.equal(ownedChildPids().length, 1)
    const owned = ownedChildPids()[0] as number
    assert.equal(isAlive(owned), true)
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

  it('kills the whole process group so subprocesses do not outlive the child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'child-group-'))
    const ready = join(dir, 'grandchild.pid')
    // The agent CLIs are wrappers: killing only the direct child leaves the
    // model and tool subprocesses running inside the workdir. The grandchild
    // reports its pid once it runs, and the kill waits for that report.
    const script =
      `node -e 'require("fs").writeFileSync("${ready}",String(process.pid));setInterval(function(){},1000)' &` +
      ' sleep 30'
    const controller = new AbortController()
    const pending = runChild('sh', ['-c', script], {
      timeoutMs: 60000,
      signal: controller.signal,
    })
    await waitUntil(() => existsSync(ready), 20000, 'grandchild started')
    const grandchild = Number(await readFile(ready, 'utf8'))
    assert.ok(grandchild > 0)
    controller.abort()
    await assert.rejects(pending, /cancelled/)
    // SIGKILL to the group is immediate; the wait only covers reaping the
    // orphan. A grandchild outside the group stays alive and hits the deadline.
    await waitUntil(
      () => !isAlive(grandchild),
      5000,
      'a grandchild outlived the kill',
    )
  })

  it('decodes multi-byte output that straddles chunk boundaries', async () => {
    // Decoding each chunk on its own turns a split 3-byte character into two
    // replacement characters, and that text becomes the agent's repair prompt.
    const text = '\u3042'.repeat(200000)
    const res = await runChild(
      'node',
      ['-e', `process.stdout.write('\\u3042'.repeat(200000))`],
      // Keep the whole stream: the corruption lands at a pipe-buffer boundary
      // early on, which the default tail slice would silently discard.
      { timeoutMs: 20000, maxOutputChars: 1_000_000 },
    )
    assert.equal(res.stdout.includes('\uFFFD'), false)
    assert.equal(res.stdout, text)
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

describe('full-output log files', () => {
  it('pauses the source while the log sink is full, so buffering stays bounded', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    const total = 200
    let produced = 0
    // A source that can always supply more, faster than the sink drains.
    const source = new Readable({
      read() {
        this.push(produced++ < total ? chunk : null)
      },
    })
    const highWaterMark = 16 * 1024
    let received = 0
    let maxBuffered = 0
    const sink = new Writable({
      highWaterMark,
      write(data: Buffer, _encoding, done) {
        received += data.length
        setImmediate(done)
      },
    })
    const log = teeLog(source, sink)
    source.on('data', (data: Buffer) => {
      log.write(data)
      maxBuffered = Math.max(maxBuffered, sink.writableLength)
    })
    await new Promise((resolve) => source.once('end', resolve))
    assert.equal(await log.close(), null)
    assert.equal(received, chunk.length * total)
    // One chunk may land past the mark before the source pauses; without
    // backpressure the whole stream would queue in memory.
    assert.ok(
      maxBuffered <= highWaterMark + chunk.length,
      `buffered ${maxBuffered} bytes`,
    )
  })

  it('keeps every byte of a large output on disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'child-log-'))
    const stdoutFile = join(dir, 'stdout.log')
    const size = 8 * 1024 * 1024
    const res = await runChild(
      'node',
      ['-e', `process.stdout.write('x'.repeat(${size}) + 'END')`],
      { timeoutMs: 30000, stdoutFile },
    )
    assert.equal(res.code, 0)
    assert.equal(res.logError, null)
    const written = await readFile(stdoutFile, 'utf8')
    assert.equal(written.length, size + 3)
    assert.ok(written.endsWith('END'))
  })

  it('keeps the exit code when a log file cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'child-log-'))
    const res = await runChild('sh', ['-c', 'echo out; exit 3'], {
      timeoutMs: 10000,
      stdoutFile: join(dir, 'missing', 'stdout.log'),
    })
    assert.equal(res.code, 3)
    assert.equal(res.stdout, 'out\n')
    assert.match(res.logError ?? '', /ENOENT/)
  })
})
