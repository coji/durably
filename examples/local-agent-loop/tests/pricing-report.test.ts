import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRICE_BASIS, estimateCostUsd } from '../src/pricing.js'
import { reportToMarkdown } from '../src/report.js'
import type { LoopReport } from '../src/report.js'

function baseReport(): LoopReport {
  return {
    runId: 'r1',
    jobName: 'agent-loop',
    status: 'waiting',
    input: {},
    output: null,
    fake: true,
    realLlmCallCount: 0,
    fullLoopVerified: false,
    attempts: [
      {
        stepName: 'implement:1',
        stepIndex: 1,
        attemptId: 'a1',
        leaseGeneration: 1,
        status: 'completed',
        startedAt: 't',
        completedAt: 't',
        interruptionReason: null,
        measurement: {
          provider: 'fake',
          fake: true,
          stage: 'implement',
          iteration: 1,
          requestedModel: null,
          requestedEffort: null,
          reportedModel: null,
          reportedEffort: null,
          versions: {},
          elapsedMs: null,
          usage: null,
          costUsdEstimate: null,
          costBasis: null,
          result: 'implemented',
          error: null,
          interruptionReason: null,
        },
      },
    ],
    waits: [],
    stageTimings: [{ stage: 'implement', elapsedMs: null, complete: false }],
    stageTotalMs: null,
    runElapsedMs: null,
    versions: {},
    priceBasis: PRICE_BASIS,
    notes: ['fake mode'],
  }
}

describe('pricing/report', () => {
  it('returns null when usage is missing (never zero-filled)', () => {
    assert.equal(estimateCostUsd('gpt-5', null), null)
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: null, outputTokens: null }),
      null,
    )
  })

  it('returns null for unknown models', () => {
    assert.equal(
      estimateCostUsd('mystery-model', { inputTokens: 100, outputTokens: 100 }),
      null,
    )
  })

  it('returns null when EITHER priced leg is missing (no partial costs)', () => {
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: 1000, outputTokens: null }),
      null,
    )
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: null, outputTokens: 1000 }),
      null,
    )
    const full = estimateCostUsd('gpt-5', {
      inputTokens: 1000,
      outputTokens: 1000,
    })
    assert.ok(full !== null && full > 0)
  })

  it('renders unknown (not 0) for missing measurements', () => {
    const md = reportToMarkdown(baseReport())
    assert.match(md, /unknown/)
    assert.doesNotMatch(md, /\| 0 \|/)
  })

  it('separates real-call counts from full-loop verification', () => {
    const md = reportToMarkdown({
      ...baseReport(),
      fake: false,
      realLlmCallCount: 3,
      fullLoopVerified: false,
      notes: ['real CLI calls observed but loop incomplete'],
    })
    assert.match(md, /real LLM calls observed: 3/)
    assert.match(md, /full loop verified: no/)
  })

  it('distinguishes human input wait from execution-slot wait', () => {
    const md = reportToMarkdown({
      ...baseReport(),
      waits: [
        {
          id: 'w1',
          name: 'human-approval',
          outcome: 'signal',
          createdAt: 't0',
          suspendedAt: 't1',
          resolvedAt: 't2',
          inputWaitMs: 60000,
          executionSlotWaitMs: 500,
        },
      ],
    })
    assert.match(md, /inputWait=60000ms/)
    assert.match(md, /executionSlotWait=500ms/)
  })
})
