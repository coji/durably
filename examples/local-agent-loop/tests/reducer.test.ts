import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decide } from '../src/policy.js'
import { reduce } from '../src/reducer.js'
import { initialState, type FactorySetup } from '../src/types.js'

const setup: FactorySetup = {
  provider: 'fake',
  fake: true,
  contextMode: 'reuse',
  workdir: '/tmp/work',
  acceptanceDir: '/tmp/acceptance',
  acceptanceHash: 'acceptance',
  checkpointsDir: '/tmp/checkpoints',
  instructionsVersion: 'v2',
  profiles: {
    code: { id: 'fake:code', provider: 'fake', model: null, effort: null },
    review: { id: 'fake:review', provider: 'fake', model: null, effort: null },
  },
  maxIterations: 2,
  agentTimeoutMs: 1,
  testTimeoutMs: 1,
}

const candidate = {
  id: 'candidate-1',
  snapshotDir: '/tmp/candidate-1',
  sourceHash: 'source-1',
  acceptanceHash: 'acceptance',
}

describe('factory reducer and policy', () => {
  it('walks code -> verify -> review -> approve -> finish', () => {
    let state = initialState(setup)
    assert.equal(decide(state).stage, 'code')
    state = reduce(state, {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
    assert.equal(decide(state).stage, 'verify')
    state = reduce(state, {
      type: 'verify.completed',
      targetId: candidate.id,
      passed: true,
      stdout: 'ok',
      exitCode: 0,
    })
    assert.equal(decide(state).stage, 'review')
    state = reduce(state, {
      type: 'review.completed',
      targetId: candidate.id,
      reviews: [
        { lens: 'correctness', decision: 'pass', notes: 'ok' },
        { lens: 'edge-cases', decision: 'pass', notes: 'ok' },
      ],
    })
    assert.equal(decide(state).stage, 'approve')
    state = reduce(state, {
      type: 'approval.completed',
      targetId: candidate.id,
      decision: 'approved',
    })
    assert.equal(decide(state).stage, 'finish')
  })

  it('invalidates verification and reviews when repair creates a candidate', () => {
    let state = initialState(setup)
    state = reduce(state, {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
    state = reduce(state, {
      type: 'verify.completed',
      targetId: candidate.id,
      passed: true,
      stdout: 'ok',
      exitCode: 0,
    })
    state = reduce(state, {
      type: 'review.completed',
      targetId: candidate.id,
      reviews: [
        { lens: 'correctness', decision: 'needsChanges', notes: 'edge' },
        { lens: 'edge-cases', decision: 'pass', notes: 'ok' },
      ],
    })
    assert.equal(decide(state).stage, 'code')
    const repaired = { ...candidate, id: 'candidate-2', sourceHash: 'source-2' }
    state = reduce(state, {
      type: 'code.completed',
      role: 'repair',
      candidate: repaired,
      session: null,
    })
    assert.equal(state.verification, null)
    assert.deepEqual(state.reviews, [])
    assert.equal(decide(state).stage, 'verify')
  })

  it('rejects stale target events', () => {
    let state = initialState(setup)
    state = reduce(state, {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
    assert.throws(
      () =>
        reduce(state, {
          type: 'verify.completed',
          targetId: 'old-candidate',
          passed: true,
          stdout: 'ok',
          exitCode: 0,
        }),
      /stale/,
    )
  })
})
