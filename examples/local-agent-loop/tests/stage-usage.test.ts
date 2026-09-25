import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  compareReports,
  comparisonToMarkdown,
  stat,
} from '../src/engine/compare.js'
import { PRICE_BASIS, estimateCostBreakdown } from '../src/engine/pricing.js'
import {
  reportToMarkdown,
  roleUsage,
  toAttemptRow,
  stageUsage,
  stageVisits,
  summarizeRun,
  type AttemptRow,
  type LoopReport,
} from '../src/engine/report.js'
import type { TokenUsage } from '../src/engine/usage.js'
import {
  configVersionOf,
  type ConfigVersionInput,
} from '../src/engine/versions.js'

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
    // gpt-5.6-sol: in 0.004, out 0.02 per 1K; OpenAI lists cache reads at
    // 0.1x and cache writes at 1.25x input.
    const b = estimateCostBreakdown(
      'gpt-5.6-sol',
      usage(10_000, 1_000, { read: 8_000, write: 1_000 }),
    )
    assert.ok(b)
    assert.equal(b.cacheAware, true)
    assert.ok(Math.abs((b.meters.input_tokens ?? 0) - 0.004) < 1e-9) // 1K non-cached
    assert.ok(Math.abs((b.meters.input_cache_read_tokens ?? 0) - 0.0032) < 1e-9)
    assert.ok(Math.abs((b.meters.input_cache_write_tokens ?? 0) - 0.005) < 1e-9)
    assert.ok(Math.abs((b.meters.output_tokens ?? 0) - 0.02) < 1e-9)
    assert.ok(Math.abs(b.totalUsd - 0.0322) < 1e-9)
  })

  it('uses the cache-read rate of each model rather than a vendor default', () => {
    // Opus 5.5 reads cache at 0.05x input and Fable 5.1 at 0.025x; the usual
    // 0.1x would overstate the cache leg of an agent run, which is most of it.
    const opus = estimateCostBreakdown(
      'claude-opus-5-5',
      usage(1_000_000, 0, { read: 1_000_000 }),
    )
    assert.ok(opus)
    assert.ok(Math.abs((opus.meters.input_cache_read_tokens ?? 0) - 0.2) < 1e-9)
    const fable = estimateCostBreakdown(
      'claude-fable-5-1',
      usage(1_000_000, 0, { read: 1_000_000 }),
    )
    assert.ok(fable)
    assert.ok(
      Math.abs((fable.meters.input_cache_read_tokens ?? 0) - 0.25) < 1e-9,
    )
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
    assert.ok(Math.abs(b.totalUsd - 0.024) < 1e-9)
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

describe('role usage', () => {
  const profiles = [
    {
      role: 'code',
      provider: 'fake',
      requestedModel: 'model-a',
      requestedEffort: 'low',
    },
    {
      role: 'correctness',
      provider: 'fake',
      requestedModel: 'model-a',
      requestedEffort: 'low',
    },
    {
      role: 'edge-cases',
      provider: 'fake',
      requestedModel: 'model-b',
      requestedEffort: 'high',
    },
  ]

  it('splits the two reviewers and keeps each requested profile', () => {
    const rows = roleUsage(
      [
        row('stage:0:code:agent', 'a1', { invocationId: 'inv-1' }),
        row('stage:0:code:agent', 'a2', {
          invocationId: 'inv-1',
          result: 'checkpoint-recovered',
        }),
        row('stage:2:code:agent', 'a3', { cost: 0.004 }),
        row('stage:4:review:correctness', 'b1', { cost: 0.002 }),
        row('stage:4:review:edge-cases', 'b2', {
          usage: usage(10, 5),
          cost: 0.003,
        }),
        row('stage:1:verify:acceptance', 'c1', { usage: null, cost: null }),
      ],
      profiles,
    )
    assert.deepEqual(
      rows.map((r) => [
        r.role,
        r.requestedModel,
        r.requestedEffort,
        r.invocations,
      ]),
      [
        ['code', 'model-a', 'low', 2],
        ['correctness', 'model-a', 'low', 1],
        ['edge-cases', 'model-b', 'high', 1],
      ],
    )
    const [code, correctness, edge] = rows
    // The recovery attempt re-reads inv-1 and adds nothing.
    assert.equal(code?.totalTokens, 300)
    assert.ok(Math.abs((code?.costUsd ?? 0) - 0.005) < 1e-9)
    assert.equal(correctness?.totalTokens, 150)
    assert.equal(edge?.totalTokens, 15)
    assert.equal(edge?.costUsd, 0.003)
    assert.ok(rows.every((r) => r.complete))
  })

  it('keeps a role without usage unknown instead of zero', () => {
    const [code, correctness] = roleUsage(
      [
        row('stage:0:code:agent', 'a1', { usage: null, cost: null }),
        row('stage:2:review:correctness', 'b1', { usage: null, cost: null }),
      ],
      profiles,
    )
    assert.equal(code?.invocations, 1)
    assert.equal(code?.totalTokens, null)
    assert.equal(code?.costUsd, null)
    assert.equal(code?.complete, false)
    assert.equal(correctness?.complete, false)
  })

  it('keeps cost incomplete when tokens are complete but a model is unpriced', () => {
    const [code] = roleUsage(
      [row('stage:0:code:agent', 'a1', { cost: null })],
      profiles,
    )
    assert.equal(code?.totalTokens, 150)
    assert.equal(code?.complete, true)
    assert.equal(code?.costUsd, null)
    assert.equal(code?.costComplete, false)
    const md = reportToMarkdown({ ...report('r6'), roleUsage: [code!] })
    assert.match(md, /\| unknown \| complete \| PARTIAL \|/)
  })

  it('renders one row per role with requested settings', () => {
    const md = reportToMarkdown(report('r5'))
    assert.match(md, /## Role usage/)
    assert.match(
      md,
      /\| code \| codex \| gpt-5\.6-sol \| low \| 1 \| 1000 \| 500 \| unknown \| 100 \| 1100 \| 0\.010000 \| complete \| complete \|/,
    )
    assert.match(
      md,
      /\| edge-cases \| claude \| claude-sonnet-5 \| \(default\) \| 1 \|/,
    )
    assert.match(md, /- task: a{64} \(\/tmp\/task\.md\)/)
    assert.match(md, /- spec: not given/)
    assert.match(md, /- branch: factory\/r5/)
    assert.match(md, /- commit: c{40}/)
  })
})

describe('config version', () => {
  const profile = {
    provider: 'codex',
    requestedModel: 'gpt-5.6-sol',
    requestedEffort: null,
    effectiveModel: 'gpt-5.6-sol',
    effectiveEffort: 'low',
  }
  const base: ConfigVersionInput = {
    contextMode: 'reuse',
    instructionsVersion: 'v',
    maxIterations: 2,
    target: 'subject',
    agentTimeoutMs: 1,
    checkTimeoutMs: 1,
    code: profile,
    correctness: profile,
    edgeCases: profile,
  }

  it('changes when any role changes provider, model or effort', () => {
    const reference = configVersionOf(base)
    assert.equal(configVersionOf({ ...base }), reference)
    for (const role of ['code', 'correctness', 'edgeCases'] as const) {
      for (const change of [
        { provider: 'claude' },
        { requestedModel: 'gpt-5.6-terra', effectiveModel: 'gpt-5.6-terra' },
        { requestedEffort: 'high', effectiveEffort: 'high' },
      ]) {
        assert.notEqual(
          configVersionOf({ ...base, [role]: { ...profile, ...change } }),
          reference,
          `${role} ${JSON.stringify(change)}`,
        )
      }
    }
  })

  it('keeps the version of a run without triage, and changes with any triage profile', () => {
    // The hash as it was computed before triage existed.
    const prior = createHash('sha256')
      .update(
        JSON.stringify({
          contextMode: base.contextMode,
          instructionsVersion: base.instructionsVersion,
          maxIterations: base.maxIterations,
          target: base.target,
          agentTimeoutMs: base.agentTimeoutMs,
          checkTimeoutMs: base.checkTimeoutMs,
          code: profile,
          correctness: profile,
          edgeCases: profile,
        }),
      )
      .digest('hex')
      .slice(0, 16)
    assert.equal(configVersionOf(base), prior)
    assert.equal(configVersionOf({ ...base, triage: null }), prior)
    const withTriage = configVersionOf({ ...base, triage: profile })
    assert.notEqual(withTriage, prior)
    for (const change of [
      { provider: 'claude' },
      { requestedModel: 'gpt-5.6-terra', effectiveModel: 'gpt-5.6-terra' },
      { requestedEffort: 'high', effectiveEffort: 'high' },
    ]) {
      assert.notEqual(
        configVersionOf({ ...base, triage: { ...profile, ...change } }),
        withTriage,
        JSON.stringify(change),
      )
    }
  })
})

describe('triage usage', () => {
  it('counts triage once under its own stage and role, across recovery', () => {
    const attempts = [
      row('triage', 't1', { invocationId: 'inv-t', result: 'uncertain' }),
      row('triage', 't2', {
        invocationId: 'inv-t',
        result: 'checkpoint-recovered',
      }),
      row('stage:1:code:agent', 'a1'),
    ]
    const stages = stageUsage(attempts)
    assert.deepEqual(
      stages.map((u) => [u.stage, u.invocations]),
      [
        ['triage', 1],
        ['code', 1],
      ],
    )
    assert.equal(stages[0]?.totalTokens, 150)
    assert.equal(stages[0]?.costUsd, 0.001)
    const roles = roleUsage(attempts, [
      {
        role: 'code',
        provider: 'codex',
        requestedModel: null,
        requestedEffort: null,
      },
      {
        role: 'triage',
        provider: 'codex',
        requestedModel: 'gpt-5.6-sol',
        requestedEffort: 'low',
      },
    ])
    assert.deepEqual(
      roles.map((r) => [r.role, r.invocations, r.totalTokens]),
      [
        ['code', 1, 150],
        ['triage', 1, 150],
      ],
    )
    const md = reportToMarkdown(report('t1', { triage: 'probe' }))
    assert.match(md, /- judgment: probe/)
    assert.match(md, /- reason: fake probe reason\./)
    assert.match(md, /\| triage \| n\/a \| n\/a \| 1 \|/)
    assert.match(
      reportToMarkdown(report('t2')),
      /- none \(no triage profile, or triage has not run yet\)/,
    )
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
    triage?: 'routine' | 'probe' | 'unknown'
    triageCost?: number | null
    conclusion?: string
    repaired?: boolean
  } = {},
): LoopReport {
  const approved = opts.approved ?? true
  const attempts = [
    ...(opts.triage
      ? [
          row('triage', `${runId}-t`, {
            usage: usage(10, 5),
            cost: opts.triageCost === undefined ? 0.0005 : opts.triageCost,
            result: 'triage-done',
            configVersion: opts.configVersion,
          }),
        ]
      : []),
    ...(opts.repaired
      ? [
          row('stage:4:code:agent', `${runId}-b`, {
            cost: 0.01,
            configVersion: opts.configVersion,
          }),
        ]
      : []),
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
    conclusion: opts.conclusion ?? (approved ? 'approved' : 'rejected'),
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
    triage: opts.triage
      ? { judgment: opts.triage, reason: `fake ${opts.triage} reason.` }
      : null,
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
    roleUsage: roleUsage(attempts, [
      {
        role: 'code',
        provider: 'codex',
        requestedModel: 'gpt-5.6-sol',
        requestedEffort: 'low',
      },
      {
        role: 'correctness',
        provider: 'codex',
        requestedModel: 'gpt-5.6-sol',
        requestedEffort: 'low',
      },
      {
        role: 'edge-cases',
        provider: 'claude',
        requestedModel: 'claude-sonnet-5',
        requestedEffort: null,
      },
    ]),
    inputs: {
      task: { path: '/tmp/task.md', sha256: 'a'.repeat(64) },
      spec: null,
      dispositions: null,
    },
    candidate: null,
    candidates: [],
    reviews: [],
    reviewRounds: [],
    delivery: {
      kind: 'patch',
      location: '/tmp/c.patch',
      summary: 'patch',
      branch: `factory/${runId}`,
      commit: 'c'.repeat(40),
    },
    failure: null,
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

describe('comparison by triage judgment', () => {
  it('shows outcomes, repairs and costs per judgment, and routine misses', () => {
    const c = compareReports([
      report('r1', { triage: 'routine' }),
      report('r2', { triage: 'routine', repaired: true }),
      report('r3', {
        triage: 'routine',
        approved: false,
        conclusion: 'review-cap-reached',
      }),
      report('p1', {
        triage: 'probe',
        approved: false,
        conclusion: 'verification-failed',
        repaired: true,
      }),
      report('u1', { triage: 'unknown', triageCost: null }),
    ])
    assert.equal(c.groups.length, 1)
    const [routine, probe, unknown] = c.groups[0]?.triage ?? []
    assert.deepEqual(
      [
        routine?.judgment,
        routine?.runs,
        routine?.approved,
        routine?.verificationFailed,
        routine?.reviewCapReached,
        routine?.routineNeedingMore,
      ],
      ['routine', 3, 2, 0, 1, 2],
    )
    assert.deepEqual([routine?.repairs.median, routine?.repairs.max], [0, 1])
    assert.deepEqual(
      [probe?.runs, probe?.verificationFailed, probe?.routineNeedingMore],
      [1, 1, 0],
    )
    // An unpriced triage call leaves the run's cost unknown, not zero.
    assert.equal(unknown?.costUsd.n, 0)
    assert.equal(unknown?.costUsd.unknown, 1)
    const md = comparisonToMarkdown(c)
    assert.match(md, /By triage judgment/)
    assert.match(
      md,
      /\| routine \| 3 \| 2 \| 0 \| 1 \| 0 \[0\.\.1\] \(n=3\) \| .* \| 2 \|/,
    )
    assert.match(
      md,
      /\| probe \| 1 \| 0 \| 1 \| 0 \| 1 \[1\.\.1\] \(n=1\) \| .* \| - \|/,
    )
    assert.match(
      md,
      /\| unknown \| 1 \| 1 \| 0 \| 0 \| .* \| unknown \(1 unknown\) \| - \|/,
    )
    const json = JSON.parse(JSON.stringify(c)) as typeof c
    assert.equal(json.groups[0]?.triage[0]?.routineNeedingMore, 2)
    assert.equal(json.groups[0]?.triage[2]?.costUsd.median, null)
    // A group without triage gets no rows and no table.
    const plain = compareReports([report('n1')])
    assert.deepEqual(plain.groups[0]?.triage, [])
    assert.doesNotMatch(comparisonToMarkdown(plain), /By triage judgment/)
  })
})

describe('measurement detection', () => {
  it('does not mistake a step that merely records a provider for a measurement', () => {
    // `setup` stores { stage, provider, context, target } for context. Keying
    // on `provider` alone rendered that as an attempt row of unknowns beside
    // the real invocations.
    const row = toAttemptRow({
      id: 'a1',
      stepName: 'setup',
      stepIndex: 0,
      leaseGeneration: 1,
      status: 'completed',
      startedAt: 't',
      completedAt: 't',
      interruptionReason: null,
      metadata: {
        stage: 'setup',
        provider: 'codex',
        context: 'reuse',
        target: 'repo',
      },
    } as never)
    assert.equal(row.measurement, null)
  })

  it('recognises a real measurement', () => {
    const row = toAttemptRow({
      id: 'a2',
      stepName: 'stage:0:code:agent',
      stepIndex: 1,
      leaseGeneration: 1,
      status: 'completed',
      startedAt: 't',
      completedAt: 't',
      interruptionReason: null,
      metadata: {
        provider: 'codex',
        invocationId: 'inv-1',
        usageScope: 'invocation',
        usage: null,
      },
    } as never)
    assert.equal(row.measurement?.invocationId, 'inv-1')
  })
})
