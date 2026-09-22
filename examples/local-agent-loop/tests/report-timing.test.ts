import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRICE_BASIS } from '../src/pricing.js'
import {
  reportToMarkdown,
  stageTimings,
  totalStageMs,
  type AttemptRow,
} from '../src/report.js'

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
      row('implement:1', 'a1', 100),
      row('implement:1', 'a2', null),
    ])
    assert.equal(timings.length, 1)
    assert.equal(timings[0]?.stage, 'implement')
    assert.equal(timings[0]?.elapsedMs, 100)
    assert.equal(timings[0]?.complete, false)
  })

  it('marks a stage complete when every attempt reports elapsedMs', () => {
    const timings = stageTimings([row('implement:1', 'a1', 100)])
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
      realLlmCallCount: 1,
      fullLoopVerified: false,
      attempts: [row('implement:1', 'a1', 100), row('implement:1', 'a2', null)],
      waits: [],
      stageTimings: stageTimings([
        row('implement:1', 'a1', 100),
        row('implement:1', 'a2', null),
      ]),
      stageTotalMs: null,
      runElapsedMs: 200,
      versions: {},
      priceBasis: PRICE_BASIS,
      notes: [],
    })
    assert.match(md, /PARTIAL/)
  })
})
