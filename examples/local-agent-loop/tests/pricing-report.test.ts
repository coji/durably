import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { estimateCostUsd } from '../src/pricing.js'
import { reportToMarkdown } from '../src/report.js'

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

  it('renders unknown (not 0) for missing measurements', () => {
    const md = reportToMarkdown({
      runId: 'r1',
      jobName: 'agent-loop',
      status: 'waiting',
      input: {},
      output: null,
      fake: true,
      verifiedByRealLlm: false,
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
            model: null,
            effort: null,
            elapsedMs: null,
            usage: null,
            costUsdEstimate: null,
            costBasis: null,
            result: 'implemented',
            error: null,
          },
        },
      ],
      waits: [],
      notes: ['fake mode'],
    })
    assert.match(md, /unknown/)
    assert.doesNotMatch(md, /\| 0 \|/)
  })
})
