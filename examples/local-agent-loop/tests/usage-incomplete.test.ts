import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { aggregateUsage } from '../src/engine/usage.js'

describe('aggregateUsage completeness (reviewer repro)', () => {
  it('marks the aggregate incomplete when an LLM attempt has no usage', () => {
    const agg = aggregateUsage([
      { attemptId: 'interrupted', usage: null },
      {
        attemptId: 'done',
        usage: {
          inputTokens: 100,
          cachedInputTokens: null,
          outputTokens: 10,
          totalTokens: 110,
          usageSource: 'provider-final',
        },
      },
    ])
    assert.equal(agg.inputTokens, 100)
    assert.equal(agg.outputTokens, 10)
    assert.deepEqual(agg.missingAttempts, ['interrupted'])
    assert.equal(
      agg.complete,
      false,
      'a partial sum that excludes an interrupted attempt must not read as complete',
    )
  })

  it('excludes non-LLM steps (no usage expected) without marking incomplete', () => {
    const agg = aggregateUsage([
      {
        attemptId: 'test-step',
        usage: null,
        expectsUsage: false,
      },
      {
        attemptId: 'done',
        usage: {
          inputTokens: 100,
          cachedInputTokens: null,
          outputTokens: 10,
          totalTokens: 110,
          usageSource: 'provider-final',
        },
      },
    ])
    assert.equal(agg.complete, true)
    assert.deepEqual(agg.missingAttempts, [])
  })
})
