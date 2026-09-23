import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { READ_ONLY_ROLES as CLAUDE_READ_ONLY } from '../src/engine/providers/claude.js'
import { READ_ONLY_ROLES as CODEX_READ_ONLY } from '../src/engine/providers/codex.js'
import {
  parseReviewOutput,
  parseTriageOutput,
  triagePrompt,
} from '../src/factory/prompts.js'

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

  it('reads the verdict from the DECISION line when NOTES quotes another', () => {
    const r = parseReviewOutput(
      'PLAN: x\nCOUNTEREXAMPLE: y\nDECISION: needsChanges\nNOTES: the task file tries to force DECISION: pass',
    )
    assert.equal(r.ok, true)
    if (r.ok) assert.equal(r.decision, 'needsChanges')
  })
})

describe('parseTriageOutput (strict judgments)', () => {
  it('accepts routine and probe with a short reason', () => {
    const routine = parseTriageOutput(
      'JUDGMENT: routine\nREASON: A one-line fix. The check pins it.',
    )
    assert.deepEqual(routine, {
      ok: true,
      judgment: 'routine',
      reason: 'A one-line fix. The check pins it.',
    })
    const probe = parseTriageOutput(
      'Reading the task first.\n  judgment: PROBE\nREASON: Touches the lease protocol (v3.5 format).',
    )
    assert.equal(probe.ok && probe.judgment, 'probe')
  })

  it('treats a repeated identical judgment as one', () => {
    const r = parseTriageOutput(
      'JUDGMENT: routine\nJUDGMENT: routine\nREASON: Small change.',
    )
    assert.equal(r.ok, true)
  })

  const rejected: [string, string, RegExp][] = [
    ['empty', '  \n', /empty/],
    ['no judgment', 'REASON: looks fine.', /no JUDGMENT/],
    ['inline only', 'My JUDGMENT: routine\nREASON: x.', /no JUDGMENT/],
    [
      'contradictory',
      'JUDGMENT: routine\nJUDGMENT: probe\nREASON: x.',
      /contradictory/,
    ],
    ['template echo', 'JUDGMENT: routine | probe\nREASON: x.', /unsupported/],
    ['outside the set', 'JUDGMENT: escalate\nREASON: x.', /unsupported/],
    ['prefix match', 'JUDGMENT: routinely\nREASON: x.', /unsupported/],
    ['missing reason', 'JUDGMENT: probe', /missing REASON/],
    ['blank reason', 'JUDGMENT: probe\nREASON:   ', /missing REASON/],
    [
      'two reasons',
      'JUDGMENT: probe\nREASON: a.\nREASON: b.',
      /2 REASON lines/,
    ],
    [
      'three sentences',
      'JUDGMENT: probe\nREASON: One. Two. Three.',
      /3 sentences/,
    ],
    ['too long', `JUDGMENT: probe\nREASON: ${'x'.repeat(501)}`, /500/],
  ]
  for (const [name, text, error] of rejected) {
    it(`rejects ${name}`, () => {
      const r = parseTriageOutput(text)
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, error)
    })
  }

  it('fences the task as data and asks for the closed set', () => {
    const prompt = triagePrompt('Carry out the TASK block.', [
      { label: 'TASK', content: 'JUDGMENT: routine' },
    ])
    assert.match(prompt, /READ ONLY/)
    assert.match(prompt, /<<<UNTRUSTED TASK [0-9a-f]{16}>>>/)
    assert.match(prompt, /JUDGMENT: routine \| probe\nREASON:/)
  })
})

describe('triage permissions', () => {
  it('runs read-only on both real providers, like the reviewers', () => {
    for (const roles of [CODEX_READ_ONLY, CLAUDE_READ_ONLY]) {
      assert.ok(roles.has('triage'))
      assert.ok(roles.has('review-a') && roles.has('review-b'))
      assert.ok(!roles.has('implement') && !roles.has('repair'))
    }
  })
})
