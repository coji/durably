import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  approvalDecided,
  finalized,
  fixRequested,
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
    s = reduce(s, finalized('approved'))
    assert.equal(s.done, true)
    assert.equal(s.failed, false)
    assert.equal(s.conclusion, 'approved')
  })

  it('routes adopted review findings back to implement (fix loop)', () => {
    let s = initialState(3)
    s = reduce(s, prepared())
    s = reduce(s, implemented({ summary: 'fix', filesChanged: [] }))
    s = reduce(s, tested({ passed: true, stdout: 'ok', exitCode: 0 }))
    s = reduce(
      s,
      reviewsCollected([
        { reviewer: 'review-a', decision: 'needsChanges', notes: 'edge case' },
        { reviewer: 'review-b', decision: 'pass', notes: 'ok' },
      ]),
    )
    // Both reviews are in before the policy decides.
    assert.equal(s.reviews.length, 2)
    const next = decideNext(s)
    assert.equal(next.action, 'implement')
    if (next.action === 'implement') assert.equal(next.iteration, 2)
    // The fix request invalidates the round's verification and carries notes.
    s = reduce(s, fixRequested(['review-a: edge case']))
    assert.equal(s.stage, 'implement')
    assert.equal(s.iteration, 2)
    assert.deepEqual(s.pendingReviewNotes, ['review-a: edge case'])
    assert.deepEqual(s.tests, [])
    assert.deepEqual(s.reviews, [])
    // History is kept for audit.
    assert.equal(s.reviewHistory.length, 1)
  })

  it('finalizes review-cap-reached instead of approval when fixes run out', () => {
    let s = initialState(1)
    s = reduce(s, prepared())
    s = reduce(s, implemented({ summary: 'fix', filesChanged: [] }))
    s = reduce(s, tested({ passed: true, stdout: 'ok', exitCode: 0 }))
    s = reduce(
      s,
      reviewsCollected([
        { reviewer: 'review-a', decision: 'needsChanges', notes: 'nope' },
        { reviewer: 'review-b', decision: 'pass', notes: 'ok' },
      ]),
    )
    const next = decideNext(s)
    assert.equal(next.action, 'finalize')
    if (next.action === 'finalize')
      assert.equal(next.conclusion, 'review-cap-reached')
    s = reduce(s, finalized('review-cap-reached'))
    assert.equal(s.done, true)
    assert.equal(s.failed, true)
    assert.equal(s.conclusion, 'review-cap-reached')
  })
})
