import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { presetForModel, resolveEffort } from '../src/models.js'
import { estimateCostUsd } from '../src/pricing.js'

describe('model presets', () => {
  it('maps each preset model to its default effort', () => {
    assert.equal(presetForModel('gpt-6-astra')?.effort, 'low')
    assert.equal(presetForModel('gpt-5.6-sol')?.effort, 'low')
    assert.equal(presetForModel('gpt-5.6-luna')?.effort, 'max')
    assert.equal(presetForModel('claude-fable-5-1')?.effort, 'low')
    assert.equal(presetForModel('claude-opus-5')?.effort, 'high')
    assert.equal(presetForModel('claude-sonnet-5')?.effort, 'high')
  })

  it('resolves explicit > env > preset > null', () => {
    assert.equal(resolveEffort('high', 'low', 'gpt-6-astra'), 'high')
    assert.equal(resolveEffort(undefined, 'low', 'claude-opus-5'), 'low')
    assert.equal(resolveEffort(undefined, undefined, 'gpt-5.6-luna'), 'max')
    assert.equal(resolveEffort(undefined, undefined, 'unknown'), null)
    assert.equal(resolveEffort(undefined, undefined, null), null)
  })

  it('prices preset models without cross-matching siblings', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 }
    const approx = (actual: number | null, expected: number) =>
      assert.ok(
        actual !== null && Math.abs(actual - expected) < 1e-9,
        `expected ~${expected}, got ${actual}`,
      )
    approx(estimateCostUsd('gpt-6-astra', usage), 0.06)
    approx(estimateCostUsd('gpt-5.6-sol', usage), 0.035)
    approx(estimateCostUsd('gpt-5.6-luna', usage), 0.0014)
    approx(estimateCostUsd('claude-fable-5-1', usage), 0.06)
    approx(estimateCostUsd('claude-opus-5', usage), 0.03)
    approx(estimateCostUsd('claude-sonnet-5', usage), 0.012)
  })
})
