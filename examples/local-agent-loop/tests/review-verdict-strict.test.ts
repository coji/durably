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

  it('accepts a verdict that follows a preamble on the same line', () => {
    // Verbatim shape from the factory's first real run: the reviewer narrated
    // what it was about to check and then gave the verdict on that line, and
    // a line-anchored parser threw both reviews away after they had been paid
    // for.
    const parsed = parseReviewOutput(
      '指定どおり読み取り専用で、基準コミットとの差分を確認します。DECISION: pass\n' +
        'NOTES: The guide accurately reflects the example.',
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok && parsed.decision, 'pass')
  })

  it('still refuses an echoed template, preamble or not', () => {
    for (const text of [
      'Here is my answer. DECISION: pass | needsChanges\nNOTES: unsure',
      'DECISION: pass | needsChanges\nNOTES: unsure',
    ]) {
      const parsed = parseReviewOutput(text)
      assert.equal(parsed.ok, false, text)
    }
  })

  it('still refuses two verdicts even when one is inline', () => {
    const parsed = parseReviewOutput(
      'Thinking. DECISION: pass\nOn reflection DECISION: needsChanges\nNOTES: x',
    )
    assert.equal(parsed.ok, false)
  })

  it('prefers a verdict on its own line over one narrated earlier', () => {
    // Un-anchoring the marker introduced the mirror of the bug it fixed: a
    // reviewer that announces the format and then complies left two markers,
    // and a count-based contradiction check threw the review away.
    const parsed = parseReviewOutput(
      'Reviewing per the rules; I will finish with DECISION: pass or needsChanges.\n' +
        'DECISION: pass\n' +
        'NOTES: the guide matches the example.',
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok && parsed.decision, 'pass')
  })

  it('treats a repeated identical verdict as redundant, not contradictory', () => {
    const parsed = parseReviewOutput(
      'DECISION: pass\nNOTES: fine.\nDECISION: pass',
    )
    assert.equal(parsed.ok, true)
    assert.equal(parsed.ok && parsed.decision, 'pass')
  })
})
