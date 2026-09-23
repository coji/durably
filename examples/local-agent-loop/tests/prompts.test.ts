import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseReviewOutput } from '../src/factory/prompts.js'

/** The independent-work lines every well-formed review carries. */
const W = 'PLAN: change add() only\nCOUNTEREXAMPLE: tried 0.1 + 0.2, correct\n'

describe('parseReviewOutput (strict verdicts)', () => {
  it('accepts an explicit pass', () => {
    const r = parseReviewOutput(
      W + 'DECISION: pass\nNOTES: decimals handled, diff minimal',
    )
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.decision, 'pass')
      assert.match(r.notes, /decimals/)
    }
  })

  it('accepts needsChanges with exact casing', () => {
    const r = parseReviewOutput(
      W + 'DECISION: needsChanges\nNOTES: mul() was touched',
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.decision, 'needsChanges')
  })

  it('accepts case-insensitive needsChanges (the old lowercase bug)', () => {
    for (const variant of [
      'DECISION: needsChanges',
      'DECISION: NEEDSCHANGES',
      'DECISION: needschanges',
      'decision: NeedsChanges',
    ]) {
      const r = parseReviewOutput(W + `${variant}\nNOTES: fix it`)
      assert.equal(r.ok, true, variant)
      if (r.ok) assert.equal(r.decision, 'needsChanges', variant)
    }
  })

  it('rejects empty output (never defaults to pass)', () => {
    for (const text of ['', '   ', '\n']) {
      const r = parseReviewOutput(text)
      assert.equal(r.ok, false, JSON.stringify(text))
    }
  })

  it('rejects missing DECISION lines', () => {
    const r = parseReviewOutput(W + 'looks good to me, ship it\nNOTES: fine')
    assert.equal(r.ok, false)
  })

  it('rejects garbled decisions', () => {
    const r = parseReviewOutput(W + 'DECISION: maybe\nNOTES: unsure')
    assert.equal(r.ok, false)
  })

  it('rejects contradictory double decisions', () => {
    const r = parseReviewOutput(
      W + 'DECISION: pass\nDECISION: needsChanges\nNOTES: confused',
    )
    assert.equal(r.ok, false)
  })

  it('rejects missing NOTES', () => {
    const r = parseReviewOutput(W + 'DECISION: pass')
    assert.equal(r.ok, false)
  })

  it('requires PLAN and COUNTEREXAMPLE, whatever the verdict', () => {
    for (const text of [
      'DECISION: pass\nNOTES: fine',
      'DECISION: needsChanges\nNOTES: fix it',
      'PLAN: p\nDECISION: pass\nNOTES: fine',
      'COUNTEREXAMPLE: c\nDECISION: pass\nNOTES: fine',
      'PLAN:\nCOUNTEREXAMPLE: c\nDECISION: pass\nNOTES: fine',
    ]) {
      const r = parseReviewOutput(text)
      assert.equal(r.ok, false, JSON.stringify(text))
      assert.match(r.ok ? '' : r.error, /missing (PLAN|COUNTEREXAMPLE) line/)
    }
  })

  it('reads PLAN, COUNTEREXAMPLE and NOTES only at the start of a line', () => {
    const r = parseReviewOutput(
      'PLAN: update the release notes: add one line\n' +
        'COUNTEREXAMPLE: see footnotes: none\n' +
        'DECISION: pass\n' +
        'NOTES: the real note',
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.notes, 'the real note')
    const inline = parseReviewOutput(
      'I made a PLAN: x and a COUNTEREXAMPLE: y\nDECISION: pass\nNOTES: z',
    )
    assert.equal(inline.ok, false)
  })
})
