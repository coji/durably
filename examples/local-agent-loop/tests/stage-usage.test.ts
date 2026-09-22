import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareReports, comparisonToMarkdown, stat } from '../src/compare.js'
import { PRICE_BASIS, estimateCostBreakdown } from '../src/pricing.js'
import {
  reportToMarkdown,
  stageUsage,
  stageVisits,
  summarizeRun,
  type AttemptRow,
  type LoopReport,
} from '../src/report.js'
import type { TokenUsage } from '../src/usage.js'

function usage(
  input: number,
  output: number,
  cache: { read?: number; write?: number } = {},
): TokenUsage {
  return {
    inputTokens: input,
    cachedInputTokens: null,
    cacheReadTokens: cache.read ?? null,
    cacheWriteTokens: cache.write ?? null,
    outputTokens: output,
    totalTokens: input + output,
    usageSource: 'provider-final',
  }
}

function row(
  stepName: string,
  attemptId: string,
  opts: {
    invocationId?: string
    usage?: TokenUsage | null
    cost?: number | null
    elapsedMs?: number | null
    result?: string
    configVersion?: string
  } = {},
): AttemptRow {
  return {
    stepName,
    stepIndex: 1,
    attemptId,
    leaseGeneration: 1,
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    interruptionReason: null,
    measurement: {
      provider: 'codex',
      fake: false,
      stage: stepName,
      iteration: 1,
      invocationId: opts.invocationId ?? attemptId,
      usageScope: 'invocation',
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'low',
      effectiveModel: 'gpt-5.6-sol',
      effectiveEffort: 'low',
      reportedModel: 'gpt-5.6-sol',
      reportedEffort: null,
      versions: {},
      elapsedMs: opts.elapsedMs ?? 1000,
      usage: opts.usage === undefined ? usage(100, 50) : opts.usage,
      costUsdEstimate: opts.cost === undefined ? 0.001 : opts.cost,
      costBasis: 'api-equivalent-estimate',
      configVersion: opts.configVersion ?? 'cfg-a',
      result: opts.result ?? 'implement-done',
      error: null,
      interruptionReason: null,
    },
  }
}

describe('pricing meters', () => {
  it('prices cache legs at their own rates and bills the remainder as input', () => {
    // gpt-5.6-sol: in 0.005, out 0.03 per 1K; cache read 10%, cache write 100%.
    const b = estimateCostBreakdown(
      'gpt-5.6-sol',
      usage(10_000, 1_000, { read: 8_000, write: 1_000 }),
    )
    assert.ok(b)
    assert.equal(b.cacheAware, true)
    assert.ok(Math.abs((b.meters.input_tokens ?? 0) - 0.005) < 1e-9) // 1K non-cached
    assert.ok(Math.abs((b.meters.input_cache_read_tokens ?? 0) - 0.004) < 1e-9)
    assert.ok(Math.abs((b.meters.input_cache_write_tokens ?? 0) - 0.005) < 1e-9)
    assert.ok(Math.abs((b.meters.output_tokens ?? 0) - 0.03) < 1e-9)
    assert.ok(Math.abs(b.totalUsd - 0.044) < 1e-9)
  })

  it('charges the Anthropic cache-write premium', () => {
    const b = estimateCostBreakdown(
      'claude-sonnet-5',
      usage(1_000, 0, { write: 1_000 }),
    )
    assert.ok(b)
    assert.equal(b.meters.input_tokens, 0)
    assert.ok(
      Math.abs((b.meters.input_cache_write_tokens ?? 0) - 0.0025) < 1e-9,
    )
    assert.equal('input_cache_read_tokens' in b.meters, false)
  })

  it('prices Claude Opus 4.6 at its published rate', () => {
    // $5 / $25 per MTok. The Opus 4.x family dropped from $15/$75 at 4.5, and
    // a stale $15/$75 row inflates every cost this report produces by 3x.
    const input = estimateCostBreakdown('claude-opus-4-6', usage(1_000_000, 0))
    assert.ok(input)
    assert.ok(Math.abs(input.totalUsd - 5) < 1e-6)
    const output = estimateCostBreakdown('claude-opus-4-6', usage(0, 1_000_000))
    assert.ok(output)
    assert.ok(Math.abs(output.totalUsd - 25) < 1e-6)
  })

  it('prices flat and says so when no cache leg was reported', () => {
    const b = estimateCostBreakdown('gpt-5.6-sol', usage(1_000, 1_000))
    assert.ok(b)
    assert.equal(b.cacheAware, false)
    assert.ok(Math.abs(b.totalUsd - 0.035) < 1e-9)
  })
})

describe('stage usage', () => {
  it('sums per stage, counting each invocation once across recovery attempts', () => {
    const rows = [
      row('stage:0:code:agent', 'a1', { invocationId: 'inv-1' }),
      row('stage:0:code:agent', 'a2', {
        invocationId: 'inv-1',
        result: 'checkpoint-recovered',
      }),
      row('stage:2:review:correctness', 'b1', { cost: 0.002 }),
      row('stage:2:review:edge-cases', 'b2', { cost: 0.003 }),
      row('stage:1:verify:acceptance', 'c1', { usage: null, cost: null }),
    ]
    const byStage = stageUsage(rows)
    assert.deepEqual(
      byStage.map((s) => s.stage),
      ['code', 'review'],
    )
    const code = byStage[0]!
    assert.equal(code.invocations, 1)
    assert.equal(code.inputTokens, 100)
    assert.equal(code.costUsd, 0.001)
    const review = byStage[1]!
    assert.equal(review.invocations, 2)
    assert.equal(review.totalTokens, 300)
    assert.ok(Math.abs((review.costUsd ?? 0) - 0.005) < 1e-9)
    assert.equal(review.complete, true)
  })

  it('reports a stage cost as unknown when one invocation is unpriced', () => {
    const [review] = stageUsage([
      row('stage:2:review:correctness', 'b1', { cost: 0.002 }),
      row('stage:2:review:edge-cases', 'b2', { cost: null }),
    ])
    assert.equal(review?.costUsd, null)
    assert.equal(review?.complete, true)
    assert.equal(review?.totalTokens, 300)
  })

  it('marks a stage partial when an LLM invocation has no usage', () => {
    const [code] = stageUsage([
      row('stage:0:code:agent', 'a1', { usage: null, cost: null }),
    ])
    assert.equal(code?.complete, false)
    assert.equal(code?.totalTokens, null)
  })
})

describe('stage visits (rework)', () => {
  it('counts distinct sequence entries per stage; extra visits are rework', () => {
    const visits = stageVisits([
      row('stage:0:code:agent', 'a1'),
      row('stage:0:code:candidate', 'a1c'),
      row('stage:1:verify:acceptance', 'v1'),
      row('stage:2:code:agent', 'a2'),
      row('stage:3:verify:acceptance', 'v2'),
      row('stage:4:review:correctness', 'r1'),
      row('decision:0', 'd0'),
      row('setup', 's'),
    ])
    assert.deepEqual(visits, [
      { stage: 'code', visits: 2, reworked: 1 },
      { stage: 'verify', visits: 2, reworked: 1 },
      { stage: 'review', visits: 1, reworked: 0 },
    ])
  })
})

function report(
  runId: string,
  opts: {
    status?: string
    approved?: boolean
    configVersion?: string
    codeCost?: number | null
    codeTokens?: number
    leadTimeMs?: number | null
    inputWaitMs?: number | null
  } = {},
): LoopReport {
  const approved = opts.approved ?? true
  const attempts = [
    row('stage:0:code:agent', `${runId}-a`, {
      cost: opts.codeCost === undefined ? 0.01 : opts.codeCost,
      usage: usage(opts.codeTokens ?? 1000, 100, { read: 500 }),
      configVersion: opts.configVersion,
    }),
    row('stage:2:review:correctness', `${runId}-r1`, {
      cost: 0.002,
      configVersion: opts.configVersion,
    }),
    row('stage:2:review:edge-cases', `${runId}-r2`, {
      cost: 0.002,
      configVersion: opts.configVersion,
    }),
  ]
  const status = opts.status ?? 'completed'
  const output = {
    approved,
    conclusion: approved ? 'approved' : 'rejected',
    reviewRounds: 1,
    fake: false,
  }
  const waits = [
    {
      id: 'w1',
      name: 'stage:3:approve:c1',
      outcome: 'signal',
      createdAt: 't0',
      suspendedAt: 't1',
      resolvedAt: 't2',
      inputWaitMs: opts.inputWaitMs === undefined ? 5000 : opts.inputWaitMs,
      executionSlotWaitMs: 10,
    },
  ]
  const su = stageUsage(attempts)
  const sv = stageVisits(attempts)
  const runElapsedMs = opts.leadTimeMs === undefined ? 20_000 : opts.leadTimeMs
  return {
    runId,
    jobName: 'local-factory.v2',
    status,
    input: { provider: 'codex', context: 'reuse' },
    output,
    fake: false,
    configVersion: opts.configVersion ?? 'cfg-a',
    summary: summarizeRun({
      status,
      output,
      runElapsedMs,
      stageTotalMs: 3000,
      waits,
      attempts,
      stageUsage: su,
      stageVisits: sv,
    }),
    stageUsage: su,
    stageVisits: sv,
    realLlmCallCount: 3,
    fullLoopVerified: approved,
    attempts,
    waits,
    stageTimings: [
      { stage: 'code', elapsedMs: 1000, wallElapsedMs: 1000, complete: true },
      { stage: 'review', elapsedMs: 2000, wallElapsedMs: 1000, complete: true },
    ],
    stageTotalMs: 3000,
    runElapsedMs,
    versions: {},
    priceBasis: PRICE_BASIS,
    notes: [],
  }
}

describe('run summary', () => {
  it('derives success, cost per success, and human wait ratio', () => {
    const r = report('r1')
    assert.equal(r.summary.success, true)
    assert.ok(Math.abs((r.summary.costUsd ?? 0) - 0.014) < 1e-9)
    assert.equal(r.summary.costPerSuccessUsd, r.summary.costUsd)
    assert.equal(r.summary.humanWaitMs, 5000)
    assert.ok(Math.abs((r.summary.humanWaitRatio ?? 0) - 0.25) < 1e-9)
    assert.equal(r.summary.llmInvocations, 3)
    assert.equal(r.summary.totalTokens, 1400)
    assert.equal(r.summary.repairs, 0)
    assert.equal(r.summary.reviewRounds, 1)
  })

  it('never attributes a cost per success to a failed run', () => {
    const r = report('r2', { approved: false })
    assert.equal(r.summary.success, false)
    assert.ok(r.summary.costUsd !== null)
    assert.equal(r.summary.costPerSuccessUsd, null)
  })

  it('keeps cost unknown when a stage is unpriced and ratio unknown without lead time', () => {
    const r = report('r3', { codeCost: null, leadTimeMs: null })
    assert.equal(r.summary.costUsd, null)
    assert.equal(r.summary.leadTimeMs, null)
    assert.equal(r.summary.humanWaitRatio, null)
  })

  it('renders the summary and stage usage table', () => {
    const md = reportToMarkdown(report('r4'))
    assert.match(md, /## Summary \(one row per run\)/)
    assert.match(md, /- success: yes \(approved\)/)
    assert.match(md, /- human wait: 5000ms \(25\.0% of lead time\)/)
    assert.match(
      md,
      /\| code \| 1 \| 0 \| 1 \| 1000 \| 500 \| unknown \| 100 \| 1100 \| 0\.010000 \|/,
    )
    assert.match(md, /- config version: cfg-a/)
  })
})

describe('cross-run comparison', () => {
  it('computes median/min/max and drops unknowns without zero-filling', () => {
    assert.deepEqual(stat([3, null, 1, 2]), {
      n: 3,
      unknown: 1,
      median: 2,
      min: 1,
      max: 3,
    })
    assert.deepEqual(stat([4, 1]), {
      n: 2,
      unknown: 0,
      median: 2.5,
      min: 1,
      max: 4,
    })
    assert.deepEqual(stat([null, undefined]), {
      n: 0,
      unknown: 2,
      median: null,
      min: null,
      max: null,
    })
  })

  it('groups by config version and reports per-group and per-stage statistics', () => {
    const c = compareReports([
      report('a1', {
        configVersion: 'cfg-a',
        codeCost: 0.01,
        codeTokens: 1000,
      }),
      report('a2', {
        configVersion: 'cfg-a',
        codeCost: 0.03,
        codeTokens: 3000,
      }),
      report('a3', {
        configVersion: 'cfg-a',
        approved: false,
        codeCost: 0.02,
        codeTokens: 2000,
      }),
      report('b1', { configVersion: 'cfg-b', codeCost: null }),
    ])
    assert.equal(c.groups.length, 2)
    const a = c.groups.find((g) => g.configVersion === 'cfg-a')!
    assert.deepEqual(a.runIds, ['a1', 'a2', 'a3'])
    assert.equal(a.runs, 3)
    assert.equal(a.successes, 2)
    assert.ok(Math.abs((a.costUsd.median ?? 0) - 0.024) < 1e-9)
    // Cost per success only over the two approved runs (0.014, 0.034).
    assert.equal(a.costPerSuccessUsd.n, 2)
    assert.ok(Math.abs((a.costPerSuccessUsd.median ?? 0) - 0.024) < 1e-9)
    const code = a.stages.find((s) => s.stage === 'code')!
    assert.equal(code.totalTokens.median, 2100) // 1100, 2100, 3100
    assert.equal(code.cacheReadTokens.median, 500)
    const b = c.groups.find((g) => g.configVersion === 'cfg-b')!
    assert.equal(b.costUsd.median, null)
    assert.equal(b.costUsd.unknown, 1)
    const md = comparisonToMarkdown(c)
    assert.match(md, /## codex\/gpt-5\.6-sol\/low\/reuse — config cfg-a/)
    assert.match(md, /- success: 2\/3 \(67%\)/)
    assert.match(md, /cost USD: unknown \(1 unknown\)/)
  })
})
