import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseReviewOutput } from '../src/prompts.js'

describe('parseReviewOutput (strict verdicts)', () => {
  it('accepts an explicit pass', () => {
    const r = parseReviewOutput(
      'DECISION: pass\nNOTES: decimals handled, diff minimal',
    )
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.decision, 'pass')
      assert.match(r.notes, /decimals/)
    }
  })

  it('accepts needsChanges with exact casing', () => {
    const r = parseReviewOutput(
      'DECISION: needsChanges\nNOTES: mul() was touched',
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
      const r = parseReviewOutput(`${variant}\nNOTES: fix it`)
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
    const r = parseReviewOutput('looks good to me, ship it\nNOTES: fine')
    assert.equal(r.ok, false)
  })

  it('rejects garbled decisions', () => {
    const r = parseReviewOutput('DECISION: maybe\nNOTES: unsure')
    assert.equal(r.ok, false)
  })

  it('rejects contradictory double decisions', () => {
    const r = parseReviewOutput(
      'DECISION: pass\nDECISION: needsChanges\nNOTES: confused',
    )
    assert.equal(r.ok, false)
  })

  it('rejects missing NOTES', () => {
    const r = parseReviewOutput('DECISION: pass')
    assert.equal(r.ok, false)
  })
})
