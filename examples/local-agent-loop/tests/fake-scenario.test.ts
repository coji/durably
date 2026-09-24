/**
 * Demo-only fake realism: latency, realistic usage, and per-run scenarios.
 * None of it may change what a fake run without these settings does.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createAgentDurably } from '../src/durably.js'
import { buildReport } from '../src/engine/build-report.js'
import {
  FakeProvider,
  FakeRun,
  parseLatency,
} from '../src/engine/providers/fake.js'
import type {
  AgentCallOptions,
  AttemptMeasurement,
} from '../src/engine/providers/types.js'
import { runAgentCall } from '../src/engine/runner.js'

function stubAttempt() {
  const snapshots: AttemptMeasurement[] = []
  return {
    id: randomUUID(),
    snapshots,
    log: { info: () => {} },
    setMetadata: async (m: unknown) => {
      snapshots.push(JSON.parse(JSON.stringify(m)) as AttemptMeasurement)
    },
  }
}

const review = (
  signal?: AbortSignal,
  role: 'review-a' | 'review-b' = 'review-a',
  reviewRound = 1,
): AgentCallOptions => ({
  prompt: 'review',
  workdir: tmpdir(),
  timeoutMs: 60000,
  requestedModel: 'fake-model',
  requestedEffort: 'low',
  role,
  reviewRound,
  signal,
})

async function callSpec(provider: FakeProvider, requestedModel: string) {
  return {
    provider,
    providerName: 'fake' as const,
    prompt: 'triage this',
    workdir: tmpdir(),
    timeoutMs: 60000,
    requestedModel,
    requestedEffort: 'medium',
    effectiveModel: 'fake-model',
    effectiveEffort: 'low',
    role: 'triage' as const,
    stage: 'triage',
    iteration: 0,
    operationKey: `test/${randomUUID()}`,
    checkpointsDir: await mkdtemp(join(tmpdir(), 'fake-checkpoints-')),
    session: null,
  }
}

describe('fake provider realism', () => {
  it('parses FAKE_LATENCY_MS and rejects a reversed range', () => {
    assert.deepEqual(parseLatency('20000-90000'), { min: 20000, max: 90000 })
    assert.deepEqual(parseLatency('500'), { min: 500, max: 500 })
    assert.equal(parseLatency(undefined), null)
    assert.throws(() => parseLatency('90-20'))
    assert.throws(() => parseLatency('fast'))
  })

  it('stops a long fake latency as soon as the call is aborted', async () => {
    const provider = new FakeProvider({
      run: new FakeRun({ latencyMs: { min: 60000, max: 60000 } }),
    })
    const controller = new AbortController()
    const started = Date.now()
    // The call is already sleeping when it returns its promise.
    const call = provider.call(review(controller.signal))
    controller.abort()
    await assert.rejects(call, /cancelled/)
    assert.ok(Date.now() - started < 5000, 'abort did not cut the wait short')
  })

  it('honors FAKE_LATENCY_MS from the environment and the abort signal', async () => {
    process.env.FAKE_LATENCY_MS = '60000-60000'
    try {
      const controller = new AbortController()
      const started = Date.now()
      const call = new FakeProvider().call(review(controller.signal))
      controller.abort()
      await assert.rejects(call, /cancelled/)
      assert.ok(Date.now() - started < 5000)
    } finally {
      delete process.env.FAKE_LATENCY_MS
    }
  })

  it('reports realistic usage that the price table prices for the requested model', async () => {
    const provider = new FakeProvider({
      run: new FakeRun({ usage: 'realistic' }),
      requestedModel: 'gpt-6-sol',
    })
    const outcome = await runAgentCall(
      new AbortController().signal,
      stubAttempt() as never,
      await callSpec(provider, 'gpt-6-sol'),
    )
    const m = outcome.measurement
    assert.equal(m.fake, true)
    assert.ok((m.usage?.inputTokens ?? 0) > 0)
    assert.ok((m.usage?.outputTokens ?? 0) > 0)
    assert.equal(typeof m.costUsdEstimate, 'number')
    assert.ok((m.costUsdEstimate ?? 0) > 0)
  })

  it('keeps usage and cost unknown without FAKE_USAGE', async () => {
    const provider = new FakeProvider({ requestedModel: 'gpt-6-sol' })
    const outcome = await runAgentCall(
      new AbortController().signal,
      stubAttempt() as never,
      await callSpec(provider, 'gpt-6-sol'),
    )
    assert.equal(outcome.measurement.usage, null)
    assert.equal(outcome.measurement.costUsdEstimate, null)
    assert.equal(outcome.measurement.reportedModel, 'fake-model')
  })

  it('applies one run scenario without touching another run or the env', async () => {
    delete process.env.FAKE_REVIEW_SEQUENCE
    const scripted = new FakeProvider({
      run: new FakeRun({
        reviewSequence: ['needsChanges'],
        reviewNotes: ['日付が 1 日ずれます。'],
      }),
    })
    const plain = new FakeProvider({ run: new FakeRun({}) })
    const a = await scripted.call(review())
    const b = await plain.call(review())
    assert.match(a.text, /DECISION: needsChanges/)
    assert.match(a.text, /NOTES: 日付が 1 日ずれます。/)
    assert.match(b.text, /DECISION: pass/)
    // A round past the script falls back to the default.
    assert.match(
      (await scripted.call(review(undefined, 'review-a', 2))).text,
      /DECISION: pass/,
    )
    assert.equal(process.env.FAKE_REVIEW_SEQUENCE, undefined)
  })

  it('answers each lens and round the same whatever the call order or replays', async () => {
    const run = new FakeRun({
      reviewSequence: ['needsChanges', 'pass', 'pass', 'needsChanges'],
      reviewNotes: ['r1 correctness', 'r1 edge', 'r2 correctness', 'r2 edge'],
    })
    const provider = new FakeProvider({ run })
    const verdict = async (role: 'review-a' | 'review-b', round: number) => {
      const text = (await provider.call(review(undefined, role, round))).text
      return `${/DECISION: (\S+)/.exec(text)?.[1]} ${/NOTES: (.*)/.exec(text)?.[1]}`
    }
    // Edge-cases answers first, then round 2 after a replay skipped round 1.
    assert.equal(await verdict('review-b', 1), 'pass r1 edge')
    assert.equal(await verdict('review-a', 1), 'needsChanges r1 correctness')
    assert.equal(await verdict('review-b', 2), 'needsChanges r2 edge')
    assert.equal(await verdict('review-a', 2), 'pass r2 correctness')
    // Asking again, as a restarted worker would, changes nothing.
    assert.equal(await verdict('review-a', 1), 'needsChanges r1 correctness')
    const [a, b] = await Promise.all([
      verdict('review-a', 2),
      verdict('review-b', 2),
    ])
    assert.deepEqual([a, b], ['pass r2 correctness', 'needsChanges r2 edge'])
  })
})

describe('fakeScenario on a real provider', () => {
  it('is refused at trigger, before a run is stored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fake-scenario-real-'))
    const durably = createAgentDurably({ stateRoot: home })
    try {
      await durably.migrate()
      await assert.rejects(
        durably.jobs.agentLoop.trigger({
          provider: 'codex',
          fakeScenario: { failIterations: 0 },
        } as never),
        /fakeScenario is only for runs where every role is fake/,
      )
      assert.deepEqual(await durably.getRuns(), [])
    } finally {
      await durably.db.destroy()
    }
  })
})

describe('demo seed smoke', { timeout: 180000 }, () => {
  it('produces every outcome the web UI shows', async () => {
    const home = await mkdtemp(join(tmpdir(), 'demo-seed-'))
    const { seed } = await import('../src/demo-seed.js')
    const result = await seed({
      home,
      latencyMs: { min: 0, max: 0 },
      longLatencyMs: { min: 0, max: 0 },
      backgroundWorker: false,
    })
    const durably = createAgentDurably({
      stateRoot: join(home, '.local', 'state', 'local-agent-loop'),
    })
    try {
      const seen = new Map<string, number>()
      for (const r of result.runs) {
        const report = await buildReport(durably, r.runId)
        const run = await durably.getRun(r.runId)
        const key =
          report.failure?.kind ??
          (run?.output as { conclusion?: string } | null)?.conclusion ??
          run?.status ??
          'missing'
        seen.set(key, (seen.get(key) ?? 0) + 1)
        assert.ok(report.fake, `${r.title} must be marked fake`)
        if (run?.status === 'completed')
          assert.ok((report.summary.costUsd ?? 0) > 0, `${r.title} has no cost`)
      }
      assert.ok((seen.get('approved') ?? 0) >= 3)
      for (const kind of [
        'verification-failed',
        'review-cap-reached',
        'uncertain-invocation',
        'rejected',
      ])
        assert.ok(seen.has(kind), `missing ${kind}: ${[...seen.keys()]}`)
      assert.equal(seen.get('waiting'), 2)
      // Without the background worker the long runs stay queued.
      assert.equal(seen.get('pending'), 2)
    } finally {
      await durably.db.destroy()
    }
  })
})
