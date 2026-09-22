import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseReviewOutput } from '../src/factory/prompts.js'

describe('parseReviewOutput whole-line validation (reviewer repro)', () => {
  it('rejects a DECISION line that carries two values', () => {
    const r = parseReviewOutput(
      'DECISION: pass | needsChanges\nNOTES: undecided',
    )
    assert.equal(r.ok, false)
  })

  it('rejects values that merely start with a valid token', () => {
    for (const text of [
      'DECISION: passage\nNOTES: invalid token',
      'DECISION: passes\nNOTES: plural',
      'DECISION: needsChanges-now\nNOTES: suffixed',
      'DECISION: passing\nNOTES: gerund',
    ]) {
      const r = parseReviewOutput(text)
      assert.equal(r.ok, false, JSON.stringify(text))
    }
  })

  it('rejects trailing content after the value', () => {
    const r = parseReviewOutput('DECISION: pass please\nNOTES: extra words')
    assert.equal(r.ok, false)
  })

  it('still accepts exact values with surrounding whitespace/casing', () => {
    for (const text of [
      'DECISION: pass\nNOTES: fine',
      'DECISION:   needsChanges  \nNOTES: fix it',
      'decision: PASS\nNOTES: shouty but exact',
    ]) {
      const r = parseReviewOutput(text)
      assert.equal(r.ok, true, JSON.stringify(text))
    }
  })
})
