import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRICE_BASIS } from '../src/engine/pricing.js'
import {
  reportToMarkdown,
  stageTimings,
  totalStageMs,
  type AttemptRow,
  type RunSummary,
} from '../src/engine/report.js'

function emptySummary(): RunSummary {
  return {
    success: false,
    conclusion: null,
    leadTimeMs: null,
    workMs: null,
    humanWaitMs: null,
    humanWaitRatio: null,
    llmInvocations: 0,
    totalTokens: null,
    costUsd: null,
    costPerSuccessUsd: null,
    repairs: 0,
    reviewRounds: 0,
  }
}

function row(
  stepName: string,
  attemptId: string,
  elapsedMs: number | null,
): AttemptRow {
  return {
    stepName,
    stepIndex: 1,
    attemptId,
    leaseGeneration: 1,
    status: 'completed',
    startedAt: 't',
    completedAt: 't',
    interruptionReason: null,
    measurement: {
      provider: 'codex',
      fake: false,
      stage: stepName,
      iteration: 1,
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'low',
      effectiveModel: 'gpt-5.6-sol',
      effectiveEffort: 'low',
      reportedModel: 'gpt-5.6-sol',
      reportedEffort: null,
      versions: {},
      elapsedMs,
      usage: null,
      costUsdEstimate: null,
      costBasis: null,
      result: 'implement-done',
      error: null,
      interruptionReason: null,
    },
  }
}

describe('stage timing completeness', () => {
  it('marks a stage partial when any attempt lacks elapsedMs', () => {
    const timings = stageTimings([
      row('stage:0:code:agent', 'a1', 100),
      row('stage:0:code:agent', 'a2', null),
    ])
    assert.equal(timings.length, 1)
    assert.equal(timings[0]?.stage, 'code')
    assert.equal(timings[0]?.elapsedMs, 100)
    assert.equal(timings[0]?.complete, false)
  })

  it('marks a stage complete when every attempt reports elapsedMs', () => {
    const timings = stageTimings([row('stage:0:code:agent', 'a1', 100)])
    assert.equal(timings[0]?.complete, true)
  })

  it('stage total is unknown when any stage is partial', () => {
    assert.equal(
      totalStageMs([
        { stage: 'implement', elapsedMs: 100, complete: true },
        { stage: 'test', elapsedMs: null, complete: false },
      ]),
      null,
    )
    assert.equal(
      totalStageMs([{ stage: 'implement', elapsedMs: 100, complete: true }]),
      100,
    )
  })

  it('markdown flags partial stages instead of presenting known-only sums', () => {
    const md = reportToMarkdown({
      runId: 'r1',
      jobName: 'agent-loop',
      status: 'completed',
      input: {},
      output: null,
      fake: false,
      configVersion: null,
      summary: emptySummary(),
      stageUsage: [],
      roleUsage: [],
      inputs: { task: null, spec: null, dispositions: null },
      candidate: null,
      delivery: null,
      stageVisits: [],
      realLlmCallCount: 1,
      fullLoopVerified: false,
      attempts: [
        row('stage:0:code:agent', 'a1', 100),
        row('stage:0:code:agent', 'a2', null),
      ],
      waits: [],
      stageTimings: stageTimings([
        row('stage:0:code:agent', 'a1', 100),
        row('stage:0:code:agent', 'a2', null),
      ]),
      stageTotalMs: null,
      runElapsedMs: 200,
      versions: {},
      priceBasis: PRICE_BASIS,
      notes: [],
    })
    assert.match(md, /PARTIAL/)
  })

  it('uses the original invocation interval after checkpoint recovery', () => {
    const recovered = row('stage:0:code:agent', 'retry', 1000)
    recovered.startedAt = '2026-01-01T00:01:00.000Z'
    recovered.completedAt = '2026-01-01T00:01:00.010Z'
    recovered.measurement = {
      ...recovered.measurement!,
      invocationId: 'same-invocation',
      recovered: true,
      result: 'checkpoint-recovered',
      invocationStartedAt: '2026-01-01T00:00:00.000Z',
      invocationCompletedAt: '2026-01-01T00:00:01.000Z',
    }
    const [timing] = stageTimings([recovered])
    assert.equal(timing?.elapsedMs, 1000)
    assert.equal(timing?.wallElapsedMs, 1000)
  })
})

function timedRow(
  stepName: string,
  attemptId: string,
  startedAt: string,
  completedAt: string,
): AttemptRow {
  const base = row(
    stepName,
    attemptId,
    Date.parse(completedAt) - Date.parse(startedAt),
  )
  return {
    ...base,
    startedAt,
    completedAt,
    measurement: {
      ...base.measurement!,
      invocationStartedAt: startedAt,
      invocationCompletedAt: completedAt,
    },
  }
}

describe('stage wall time across repeat visits', () => {
  it('sums each visit instead of spanning the stages that ran in between', () => {
    // code(0-20s) -> verify(20-40s) -> code again(200-220s)
    const timings = stageTimings([
      timedRow(
        'stage:0:code:agent',
        'a1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:20.000Z',
      ),
      timedRow(
        'stage:1:verify:acceptance',
        'v1',
        '2026-01-01T00:00:20.000Z',
        '2026-01-01T00:00:40.000Z',
      ),
      timedRow(
        'stage:2:code:agent',
        'a2',
        '2026-01-01T00:03:20.000Z',
        '2026-01-01T00:03:40.000Z',
      ),
    ])
    const code = timings.find((t) => t.stage === 'code')
    assert.equal(code?.elapsedMs, 40000)
    // Not 220000: the verify stage and the idle gap belong to neither visit.
    assert.equal(code?.wallElapsedMs, 40000)
    assert.equal(
      timings.find((t) => t.stage === 'verify')?.wallElapsedMs,
      20000,
    )
  })

  it('still spans parallel branches within one visit', () => {
    const timings = stageTimings([
      timedRow(
        'stage:2:review:correctness',
        'r1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
      ),
      timedRow(
        'stage:2:review:edge-cases',
        'r2',
        '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:12.000Z',
      ),
    ])
    const review = timings.find((t) => t.stage === 'review')
    assert.equal(review?.elapsedMs, 20000)
    assert.equal(review?.wallElapsedMs, 12000)
  })
})
