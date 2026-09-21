import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approvalDecided,
  implemented,
  prepared,
  reviewsCollected,
  tested,
} from '../src/events.js'
import { decideNext } from '../src/policy.js'
import { reduce } from '../src/reducer.js'
import { initialState } from '../src/types.js'

describe('reducer/policy', () => {
  it('walks prepare -> implement -> test(pass) -> review', () => {
    let s = initialState(2)
    s = reduce(s, prepared())
    assert.equal(s.stage, 'implement')
    s = reduce(s, implemented({ summary: 'fix', filesChanged: [] }))
    assert.equal(s.stage, 'test')
    s = reduce(s, tested({ passed: true, stdout: 'ok', exitCode: 0 }))
    assert.equal(s.stage, 'review')
    assert.equal(decideNext(s).action, 'review')
  })

  it('retries on test failure while iterations remain', () => {
    let s = initialState(2)
    s = reduce(s, prepared())
    s = reduce(s, implemented({ summary: 'miss', filesChanged: [] }))
    s = reduce(s, tested({ passed: false, stdout: 'fail', exitCode: 1 }))
    assert.equal(s.stage, 'implement')
    assert.equal(s.iteration, 2)
  })

  it('requests approval after passing reviews, finalizes on decision', () => {
    let s = initialState(2)
    s = reduce(s, prepared())
    s = reduce(s, implemented({ summary: 'fix', filesChanged: [] }))
    s = reduce(s, tested({ passed: true, stdout: 'ok', exitCode: 0 }))
    s = reduce(
      s,
      reviewsCollected([
        { reviewer: 'review-a', decision: 'pass', notes: 'ok' },
        { reviewer: 'review-b', decision: 'pass', notes: 'ok' },
      ]),
    )
    assert.equal(decideNext(s).action, 'requestApproval')
    s = reduce(s, approvalDecided('approved'))
    assert.equal(s.stage, 'finalize')
    assert.equal(s.approval, 'approved')
  })
})
