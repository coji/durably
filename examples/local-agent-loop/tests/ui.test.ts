/**
 * The web UI (`demo ui`): read-only, loopback only, and showing the same
 * reasons, commands and numbers as `status`, `report` and `compare`.
 *
 * The UI runs as the real CLI in a child process with `HOME` pointed at a
 * temporary directory, so the fixed state root resolves there. Runs are made
 * by an in-process fake-mode worker against that same database.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { createAgentDurably, dbPath } from '../src/durably.js'
import { runChild } from '../src/engine/child.js'
import { liveElapsed } from '../src/engine/report.js'
import { checkpointPaths } from '../src/engine/runner.js'
import { pollEvery } from '../src/ui/poll.js'
import {
  runName,
  SUBJECT_RUN_NAME,
  type CompareResponse,
  type RunDetailResponse,
  type RunsResponse,
} from '../src/ui/server.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'src', 'cli.ts')

describe('runName', () => {
  const repo = (extra: Record<string, unknown>) => ({
    target: { kind: 'repo', task: 'unused', issue: null, ...extra },
  })

  it('uses the issue number and title when the run came from an issue', () => {
    assert.equal(
      runName(
        repo({
          task: 'the issue body',
          issue: { number: 123, title: '  Fix the parser  ', url: 'u' },
        }),
      ),
      '#123 Fix the parser',
    )
  })

  it("uses the task's first non-empty line, without a heading mark", () => {
    assert.equal(
      runName(repo({ task: '\n\n  ## Add a --dry-run flag  \nmore detail' })),
      'Add a --dry-run flag',
    )
    const long = 'x'.repeat(200)
    const name = runName(repo({ task: long }))
    assert.equal(name.length, 80)
    assert.ok(name.endsWith('…'))
  })

  it('names the bundled subject in words, and never returns an empty name', () => {
    assert.equal(runName({ target: { kind: 'subject' } }), SUBJECT_RUN_NAME)
    assert.equal(SUBJECT_RUN_NAME, '同梱題材: calc の add を直す')
    assert.notEqual(runName(repo({ task: '   \n ' })), '')
  })
})

describe('liveElapsed', () => {
  const t0 = Date.parse('2026-09-24T10:00:00.000Z')
  const iso = (ms: number) => new Date(t0 + ms).toISOString()
  const attempt = (
    stepName: string,
    startedAt: number,
    completedAt: number | null,
    leaseGeneration = 2,
  ) => ({
    stepName,
    startedAt: iso(startedAt),
    completedAt: completedAt === null ? null : iso(completedAt),
    status: completedAt === null ? 'started' : 'completed',
    leaseGeneration,
  })

  it('measures the run from its lease and the stage from the open attempt', () => {
    const run = {
      status: 'leased',
      createdAt: iso(-5000),
      startedAt: iso(0),
      leaseGeneration: 2,
    }
    const live = liveElapsed(
      run,
      [
        attempt('setup', 0, 1000),
        attempt('stage:1:verify:check', 2000, null),
        // Left open by a worker that lost its lease: not the step running now.
        attempt('stage:3:review:correctness', 9000, null, 1),
      ],
      t0 + 12_000,
    )
    assert.deepEqual(live, {
      runMs: 12_000,
      stage: 'verify',
      stepName: 'stage:1:verify:check',
      stageMs: 10_000,
    })
  })

  it('uses the creation time before any lease, and is null once finished', () => {
    const pending = {
      status: 'pending',
      createdAt: iso(0),
      startedAt: null,
      leaseGeneration: 0,
    }
    assert.deepEqual(liveElapsed(pending, [], t0 + 3000), {
      runMs: 3000,
      stage: null,
      stepName: null,
      stageMs: null,
    })
    for (const status of ['completed', 'failed', 'cancelled'])
      assert.equal(
        liveElapsed({ ...pending, status }, [attempt('setup', 0, null)], t0),
        null,
      )
  })
})

describe('pollEvery', () => {
  it('never runs two loads at once, and stops when asked', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    let stopped = false
    const done = new Promise<void>((resolve) => {
      const stop = pollEvery(async (signal) => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        // sleep-ok(work): a load slower than the interval; nothing depends on its length
        await new Promise((r) => setTimeout(r, 30))
        active--
        assert.equal(signal.aborted, stopped)
        if (calls === 4) {
          stopped = true
          stop()
          resolve()
        }
      }, 5)
    })
    await done
    // sleep-ok(negative): a stopped poll must not load again
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(maxActive, 1)
    assert.equal(calls, 4)
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** GET with an explicit Host header, which `fetch` does not allow setting. */
function get(
  port: number,
  path: string,
  options: { host?: string; method?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${port}` },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function api<T>(port: number, path: string): Promise<T> {
  const res = await get(port, path)
  assert.equal(res.status, 200, res.body)
  return JSON.parse(res.body) as T
}

/** Start `demo ui` and resolve with the URL it prints. */
async function startUi(
  home: string,
  port: number,
): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', cli, 'ui', '--port', String(port)],
    { cwd: packageRoot, env: { ...process.env, HOME: home } },
  )
  let out = ''
  let err = ''
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /web UI \(read-only\): (\S+)/.exec(out)
      if (m?.[1]) resolve(m[1])
    })
    child.on('exit', (code) =>
      reject(new Error(`demo ui exited (${code}): ${err}`)),
    )
  })
  return { child, url }
}

async function demo(home: string, args: string[]) {
  return runChild(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: packageRoot,
    timeoutMs: 60000,
    maxOutputChars: 10_000_000,
    env: { HOME: home },
  })
}

async function until(cond: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** Every row of the tables a run lives in, to prove nothing was written. */
function snapshot(path: string): string {
  const db = new Database(path, { readonly: true })
  try {
    return JSON.stringify(
      [
        'durably_runs',
        'durably_steps',
        'durably_step_attempts',
        'durably_waits',
        'durably_run_labels',
      ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),
    )
  } finally {
    db.close()
  }
}

describe('demo ui --port', { timeout: 60000 }, () => {
  it('rejects a port that is not an integer from 1 to 65535', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-port-'))
    for (const port of ['0', '65536', 'abc', '80.5', '-1']) {
      const res = await demo(home, ['ui', '--port', port])
      assert.notEqual(res.code, 0, port)
      assert.match(res.stderr, /--port must be an integer between 1 and 65535/)
    }
    const bare = await demo(home, ['ui', '--port'])
    assert.notEqual(bare.code, 0)
    assert.equal(existsSync(join(home, '.local')), false)
  })
})

describe('web UI over fake runs', { timeout: 300000 }, () => {
  it('shows each run in its place with the CLI reasons, commands and numbers, and writes nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-'))
    const stateRoot = join(home, '.local', 'state', 'local-agent-loop')
    const port = await freePort()
    const ui = await startUi(home, port)
    try {
      // Loopback only, on the requested port.
      assert.equal(ui.url, `http://127.0.0.1:${port}/`)

      // No database yet: the page and an empty list, and nothing created.
      const page = await get(port, '/')
      assert.equal(page.status, 200)
      assert.match(page.body, /<div id="root">/)
      const empty = await api<RunsResponse>(port, '/api/runs')
      assert.equal(empty.exists, false)
      assert.deepEqual(empty.runs, [])
      assert.deepEqual(
        (await api<CompareResponse>(port, '/api/compare')).runIds,
        [],
      )
      assert.equal((await get(port, '/api/runs/nope')).status, 404)
      assert.equal(existsSync(stateRoot), false)
      assert.equal(existsSync(dbPath(stateRoot)), false)

      // Only a loopback Host, and only reads.
      assert.equal(
        (await get(port, '/api/runs', { host: `evil.example:${port}` })).status,
        403,
      )
      assert.equal(
        (await get(port, '/api/runs', { method: 'POST' })).status,
        405,
      )

      // A worker process creates the database and a run: the next read,
      // from the UI that started before either existed, shows it.
      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      delete process.env.FAKE_REVIEW_SLOW_MS
      const durably = createAgentDurably({ stateRoot })
      await durably.migrate()
      const subject = async (maxIterations = 2) =>
        (
          await durably.jobs.agentLoop.trigger({
            provider: 'fake',
            target: { kind: 'subject' as const },
            maxIterations,
            context: 'reuse',
          })
        ).id
      const ids: Record<string, string> = {}
      ids['approval'] = await subject()
      const first = await api<RunsResponse>(port, '/api/runs')
      assert.equal(first.exists, true)
      assert.deepEqual(
        first.runs.map((r) => [r.id, r.diagnosis.kind, r.needsHuman]),
        [[ids['approval'], 'pending', false]],
      )
      // Each row carries a name from the stored input, not only its ID.
      assert.equal(first.runs[0]?.name, SUBJECT_RUN_NAME)

      const status = (id: string) => async () =>
        (await durably.getRun(id))?.status
      const settled = (id: string) => async () =>
        ['completed', 'failed'].includes((await status(id)()) ?? '')
      try {
        await durably.init()
        await until(
          async () => (await status(ids['approval'] ?? '')()) === 'waiting',
          'approval wait',
        )
        // The worker's progress shows on the next read.
        const progressed = await api<RunsResponse>(port, '/api/runs')
        assert.equal(progressed.runs[0]?.diagnosis.kind, 'approval')

        // Approved and finished.
        ids['approved'] = await subject()
        await until(
          async () => (await status(ids['approved'] ?? '')()) === 'waiting',
          'second approval wait',
        )
        const approveWait = (await durably.getWaits(ids['approved'] ?? ''))[0]
        assert.ok(approveWait)
        await durably.signal(
          approveWait.id,
          {
            candidateId: (approveWait.metadata as { candidateId: string })
              .candidateId,
            decision: 'approved',
          },
          { signalId: 'ui-approve' },
        )
        await until(settled(ids['approved'] ?? ''), 'approved run')

        // A reviewer still asks for changes after the last repair.
        process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
        ids['review'] = await subject(1)
        await until(settled(ids['review'] ?? ''), 'review-cap run')
        delete process.env.FAKE_REVIEW_SEQUENCE

        // The check still fails with no repair left.
        delete process.env.FAKE_FAIL_FIRST
        ids['verification'] = await subject(1)
        await until(settled(ids['verification'] ?? ''), 'verification run')

        // An agent call with a start checkpoint and no completion.
        const uncertain = await subject(1)
        ids['uncertain'] = uncertain
        const checkpointsDir = join(
          stateRoot,
          'runs',
          uncertain,
          'operation-checkpoints',
        )
        await mkdir(checkpointsDir, { recursive: true })
        const operationKey = `${uncertain}/stage:0:code/agent`
        await writeFile(
          checkpointPaths(checkpointsDir, operationKey).started,
          `${JSON.stringify({
            operationKey,
            invocationId: 'lost-invocation',
            status: 'started',
            invocationStartedAt: new Date().toISOString(),
          })}\n`,
        )
        await until(settled(uncertain), 'uncertain run')
        process.env.FAKE_FAIL_FIRST = '0'

        // Decided with no worker to resume it.
        ids['decided'] = await subject()
        await until(
          async () => (await status(ids['decided'] ?? '')()) === 'waiting',
          'third approval wait',
        )
      } finally {
        await durably.stop()
      }
      const decidedWait = (await durably.getWaits(ids['decided'] ?? ''))[0]
      assert.ok(decidedWait)
      await durably.signal(
        decidedWait.id,
        {
          candidateId: (decidedWait.metadata as { candidateId: string })
            .candidateId,
          decision: 'rejected',
        },
        { signalId: 'ui-reject' },
      )
      // With no worker running: queued, held by a live lease, lease run out.
      ids['pending'] = await subject()
      ids['running'] = await subject()
      ids['expired'] = await subject()
      const lease = (id: string, expiresAt: Date) =>
        durably.db
          .updateTable('durably_runs')
          .set({
            status: 'leased',
            lease_owner: 'other-worker',
            lease_expires_at: expiresAt.toISOString(),
            started_at: new Date().toISOString(),
          })
          .where('id', '=', id)
          .execute()
      await lease(ids['running'] ?? '', new Date(Date.now() + 3_600_000))
      await lease(ids['expired'] ?? '', new Date(Date.now() - 60_000))
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST

      const before = snapshot(dbPath(stateRoot))
      const list = await api<RunsResponse>(port, '/api/runs')
      const row = (name: string) => {
        const found = list.runs.find((r) => r.id === ids[name])
        assert.ok(found, name)
        return found
      }
      const expected: Record<string, [string, boolean]> = {
        approval: ['approval', true],
        approved: ['finished', false],
        review: ['stopped', true],
        verification: ['stopped', true],
        uncertain: ['stopped', true],
        decided: ['decided', false],
        pending: ['pending', false],
        running: ['running', false],
        expired: ['lease-expired', false],
      }
      for (const [name, [kind, human]] of Object.entries(expected)) {
        assert.equal(row(name).diagnosis.kind, kind, name)
        assert.equal(row(name).needsHuman, human, name)
      }
      assert.equal(row('review').diagnosis.failure?.kind, 'review-cap-reached')
      assert.equal(
        row('verification').diagnosis.failure?.kind,
        'verification-failed',
      )
      assert.equal(
        row('uncertain').diagnosis.failure?.kind,
        'uncertain-invocation',
      )
      assert.equal(row('approved').conclusion, 'approved')
      // Nothing that would send the lost prompt again.
      assert.doesNotMatch(
        row('uncertain').diagnosis.next.join('\n'),
        /retrigger|trigger|demo worker/,
      )
      // A healthy leased run is running; it has provisional times and no
      // settled lead time.
      assert.ok(row('running').live)
      assert.equal(row('running').leadTimeMs, null)
      assert.equal(row('approved').live, null)
      // Newest first.
      const created = list.runs.map((r) => Date.parse(r.createdAt))
      assert.deepEqual(
        created,
        [...created].sort((a, b) => b - a),
      )

      // The same next commands as `status --run` prints.
      for (const name of [
        'approval',
        'review',
        'verification',
        'uncertain',
        'pending',
        'expired',
        'decided',
      ]) {
        const res = await demo(home, ['status', '--run', ids[name] ?? ''])
        assert.equal(res.code, 0, res.stderr)
        const shown = JSON.parse(res.stdout) as {
          diagnosis: { next: string[]; reason: string }
        }
        assert.deepEqual(row(name).diagnosis.next, shown.diagnosis.next, name)
        assert.equal(row(name).diagnosis.reason, shown.diagnosis.reason, name)
      }

      // The detail is exactly the CLI report, reviews and candidate included
      // while the run waits for approval.
      for (const name of [
        'approval',
        'approved',
        'review',
        'verification',
        'uncertain',
      ]) {
        const detail = await api<RunDetailResponse>(
          port,
          `/api/runs/${ids[name]}`,
        )
        const res = await demo(home, [
          'report',
          '--run',
          ids[name] ?? '',
          '--format',
          'json',
        ])
        assert.equal(res.code, 0, res.stderr)
        assert.deepEqual(detail.report, JSON.parse(res.stdout), name)
      }
      const waiting = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['approval']}`,
      )
      assert.equal(waiting.name, SUBJECT_RUN_NAME)
      assert.equal(waiting.report.reviews.length, 2)
      assert.ok(waiting.report.reviews.every((r) => r.notes.length > 0))
      assert.ok(waiting.report.candidate?.id)
      const md = await demo(home, ['report', '--run', ids['approval'] ?? ''])
      assert.match(md.stdout, /## Reviews\n\n- (correctness|edge-cases): pass/)
      // A fake run records no usage: unknown, never zero.
      const approvedDetail = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['approved']}`,
      )
      assert.equal(approvedDetail.report.summary.costUsd, null)
      assert.equal(row('approved').costUsd, null)

      // The comparison is exactly `compare` over the same finished runs.
      const compared = await api<CompareResponse>(port, '/api/compare')
      const finished = list.runs
        .filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status))
        .map((r) => r.id)
      assert.deepEqual(compared.runIds, finished)
      const res = await demo(home, [
        'compare',
        '--runs',
        compared.runIds.join(','),
        '--format',
        'json',
      ])
      assert.equal(res.code, 0, res.stderr)
      assert.deepEqual(compared.comparison, JSON.parse(res.stdout))
      const counts = compared.comparison.groups.reduce<Record<string, number>>(
        (acc, g) => {
          for (const [c, n] of Object.entries(g.conclusions))
            acc[c] = (acc[c] ?? 0) + n
          return acc
        },
        {},
      )
      assert.equal(counts['approved'], 1)
      assert.equal(counts['review-cap-reached'], 1)
      assert.equal(counts['verification-failed'], 1)

      // Reading, repeatedly, changed nothing in the database.
      for (let i = 0; i < 3; i++) {
        await api(port, '/api/runs')
        await api(port, '/api/compare')
        await api(port, `/api/runs/${ids['running']}`)
      }
      assert.equal(snapshot(dbPath(stateRoot)), before)
    } finally {
      ui.child.kill('SIGTERM')
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_REVIEW_SEQUENCE
    }
  })
})
