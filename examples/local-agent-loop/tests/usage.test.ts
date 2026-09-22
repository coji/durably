import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mergeUsage, aggregateUsage, emptyUsage } from '../src/engine/usage.js'

describe('usage accounting', () => {
  it('merges incrementally, never downgrades the source', () => {
    const base = emptyUsage()
    const partial = mergeUsage(base, {
      inputTokens: 100,
      outputTokens: null,
      usageSource: 'provider-partial',
    })
    assert.equal(partial?.inputTokens, 100)
    assert.equal(partial?.outputTokens, null)
    assert.equal(partial?.usageSource, 'provider-partial')
    // Final snapshot fills the missing leg and escalates the source.
    const fin = mergeUsage(partial, {
      outputTokens: 50,
      totalTokens: 150,
      usageSource: 'provider-final',
    })
    assert.equal(fin?.inputTokens, 100)
    assert.equal(fin?.outputTokens, 50)
    assert.equal(fin?.usageSource, 'provider-final')
    // A later partial never downgrades a final.
    const late = mergeUsage(fin, {
      inputTokens: 10,
      usageSource: 'provider-partial',
    })
    assert.equal(late?.inputTokens, 10)
    assert.equal(late?.usageSource, 'provider-final')
  })

  it('a failure merge preserves reported usage (no wipe to null)', () => {
    const reported = mergeUsage(emptyUsage(), {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      usageSource: 'provider-final',
    })
    const afterFail = mergeUsage(reported, null)
    assert.deepEqual(afterFail, reported)
  })

  it('aggregates once per attempt id (no double count on re-report)', () => {
    const u = {
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 50,
      totalTokens: 150,
      usageSource: 'provider-final' as const,
    }
    const agg = aggregateUsage([
      { attemptId: 'a1', usage: u },
      { attemptId: 'a1', usage: u },
      { attemptId: 'a2', usage: u },
    ])
    assert.equal(agg.inputTokens, 200)
    assert.equal(agg.outputTokens, 100)
    assert.equal(agg.complete, true)
  })

  it('separates missing legs instead of zero-filling', () => {
    const agg = aggregateUsage([
      {
        attemptId: 'a1',
        usage: {
          inputTokens: 100,
          cachedInputTokens: null,
          outputTokens: 50,
          totalTokens: 150,
          usageSource: 'provider-final',
        },
      },
      { attemptId: 'a2', usage: null },
      {
        attemptId: 'a3',
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: 20,
          totalTokens: null,
          usageSource: 'provider-partial',
        },
      },
    ])
    assert.equal(agg.inputTokens, 100)
    assert.equal(agg.outputTokens, 70)
    assert.deepEqual(agg.missingAttempts, ['a2'])
    assert.equal(agg.complete, false)
  })
})
