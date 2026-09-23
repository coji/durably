import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FactoryEventSchema } from '../src/factory/events.js'
import { decide } from '../src/factory/policy.js'
import { reduce } from '../src/factory/reducer.js'
import { initialState, type FactorySetup } from '../src/factory/types.js'

function profile(role: string, provider: 'fake', model: string) {
  return {
    id: `${provider}:${model}:low:${role}`,
    provider,
    requestedModel: model,
    requestedEffort: 'low',
    effectiveModel: 'fake-model',
    effectiveEffort: 'low',
  }
}

const setup: FactorySetup = {
  fake: true,
  contextMode: 'reuse',
  target: {
    kind: 'subject',
    workdir: '/tmp/work',
    baselineDir: '/tmp/baseline',
    baselineHash: 'baseline',
    acceptanceDir: '/tmp/acceptance',
    acceptanceHash: 'acceptance',
    candidatesDir: '/tmp/candidates',
    testTimeoutMs: 1,
  },
  checkpointsDir: '/tmp/checkpoints',
  instructionsVersion: 'v3',
  configVersion: 'cfg-test',
  profiles: {
    code: profile('code', 'fake', 'model-a'),
    correctness: profile('correctness', 'fake', 'model-a'),
    'edge-cases': profile('edge-cases', 'fake', 'model-b'),
  },
  maxIterations: 2,
  agentTimeoutMs: 1,
  autoApprove: false,
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

  it('keeps the per-role profiles in the setup it carries', () => {
    const state = initialState(setup)
    assert.equal(state.setup.profiles.correctness.requestedModel, 'model-a')
    assert.equal(state.setup.profiles['edge-cases'].requestedModel, 'model-b')
    assert.notEqual(
      state.setup.profiles.correctness.id,
      state.setup.profiles['edge-cases'].id,
    )
  })

  it('persists the delivered branch and commit with the approved candidate', () => {
    let state = initialState(setup)
    state = reduce(state, {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
    const event = FactoryEventSchema.parse(
      JSON.parse(
        JSON.stringify({
          type: 'factory.finished',
          outcome: {
            approved: true,
            conclusion: 'approved',
            candidate,
            iterations: 1,
            reviewRounds: 1,
            reviews: [],
            workdir: '/tmp/work',
            fake: true,
            delivery: {
              kind: 'patch',
              location: '/tmp/delivery/candidate-1.patch',
              summary: 'patch for candidate-1',
              branch: 'factory/run-1',
              commit: 'c'.repeat(40),
            },
          },
        }),
      ),
    )
    state = reduce(state, event)
    assert.deepEqual(state.outcome?.candidate, candidate)
    assert.equal(state.outcome?.delivery?.branch, 'factory/run-1')
    assert.equal(state.outcome?.delivery?.commit, 'c'.repeat(40))
  })

  it('reads a delivery recorded without branch and commit as null', () => {
    const event = FactoryEventSchema.parse({
      type: 'factory.finished',
      outcome: {
        approved: true,
        conclusion: 'approved',
        candidate,
        iterations: 1,
        reviewRounds: 1,
        reviews: [],
        workdir: '/tmp/work',
        fake: true,
        delivery: { kind: 'snapshot', location: '/tmp/c', summary: 's' },
      },
    })
    assert.equal(event.type, 'factory.finished')
    if (event.type === 'factory.finished') {
      assert.equal(event.outcome.delivery?.branch, null)
      assert.equal(event.outcome.delivery?.commit, null)
    }
  })
})
