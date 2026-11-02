import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FactoryEventSchema } from '../src/factory/events.js'
import { decide } from '../src/factory/policy.js'
import { reduce, repairsReviewFeedback } from '../src/factory/reducer.js'
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

  it('keeps review findings out of the state and the run outcome', () => {
    const findings = {
      blocker: [{ severity: 'blocker', title: 'broken', body: 'fix it' }],
      nonBlocker: [],
      counts: { blocker: 1, nonBlocker: 0 },
    }
    let state = reduce(initialState(setup), {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
    // What a findings-json review step returns, verdict and findings both.
    state = reduce(
      state,
      FactoryEventSchema.parse({
        type: 'review.completed',
        targetId: candidate.id,
        reviews: [
          {
            lens: 'correctness',
            decision: 'needsChanges',
            notes: 'broken',
            findings,
          },
          { lens: 'edge-cases', decision: 'pass', notes: 'ok', findings: null },
        ],
      }),
    )
    // The approval wait's metadata is `state.reviews`, as is the outcome.
    assert.deepEqual(state.reviews, [
      { lens: 'correctness', decision: 'needsChanges', notes: 'broken' },
      { lens: 'edge-cases', decision: 'pass', notes: 'ok' },
    ])
    const finished = FactoryEventSchema.parse({
      type: 'factory.finished',
      outcome: {
        approved: false,
        conclusion: 'review-cap-reached',
        candidate,
        iterations: 1,
        reviewRounds: 1,
        reviews: [
          {
            lens: 'correctness',
            decision: 'needsChanges',
            notes: 'broken',
            findings,
          },
        ],
        workdir: '/tmp/work',
        fake: true,
        delivery: null,
      },
    })
    const outcome = reduce(state, finished).outcome
    assert.deepEqual(outcome?.reviews, [
      { lens: 'correctness', decision: 'needsChanges', notes: 'broken' },
    ])
  })
})

describe("the implementer's notes in the state", () => {
  const code = (
    role: 'implement' | 'repair',
    id: string,
    implementerNotes?: string,
  ) =>
    FactoryEventSchema.parse({
      type: 'code.completed',
      role,
      candidate: { ...candidate, id },
      session: null,
      ...(implementerNotes !== undefined ? { implementerNotes } : {}),
    })

  it("keep the current candidate's notes and replace them on the next code attempt, even with none", () => {
    let state = initialState(setup)
    assert.equal(state.implementerNotes, null)
    state = reduce(state, code('implement', 'candidate-1', 'left mul'))
    assert.equal(state.implementerNotes, 'left mul')
    state = reduce(state, {
      type: 'verify.completed',
      targetId: 'candidate-1',
      passed: true,
      stdout: 'ok',
      exitCode: 0,
    })
    // Kept through the candidate's verification, for its reviewers.
    assert.equal(state.implementerNotes, 'left mul')
    state = reduce(state, code('repair', 'candidate-2', 'left the docs'))
    assert.equal(state.implementerNotes, 'left the docs')
    state = reduce(state, code('repair', 'candidate-3'))
    assert.equal(state.implementerNotes, null)
  })

  it('reduce the same stored events to the same notes, once, on every replay', () => {
    const events = [
      code('implement', 'candidate-1', 'left mul'),
      code('repair', 'candidate-2', 'left the docs'),
    ]
    const replay = () => events.reduce(reduce, initialState(setup))
    assert.deepEqual(replay(), replay())
    assert.equal(replay().implementerNotes, 'left the docs')
  })

  it('reduce an event stored before the field existed to no notes', () => {
    const state = reduce(
      reduce(initialState(setup), code('implement', 'candidate-1', 'left mul')),
      FactoryEventSchema.parse({
        type: 'code.completed',
        role: 'repair',
        candidate,
        session: null,
      }),
    )
    assert.equal(state.implementerNotes, null)
  })

  it('refuse stored notes that are empty or over 4 KiB', () => {
    assert.throws(() => code('implement', 'candidate-1', ''))
    assert.throws(() => code('implement', 'candidate-1', 'あ'.repeat(1366)))
    assert.equal(
      code('implement', 'candidate-1', 'a'.repeat(4096)).type,
      'code.completed',
    )
  })
})

describe('repairsReviewFeedback', () => {
  const implemented = () =>
    reduce(initialState(setup), {
      type: 'code.completed',
      role: 'implement',
      candidate,
      session: null,
    })
  const verdicts = (decision: 'pass' | 'needsChanges') => [
    { lens: 'correctness' as const, decision, notes: 'n' },
    { lens: 'edge-cases' as const, decision: 'pass' as const, notes: 'ok' },
  ]
  const failedBeside = (decision: 'pass' | 'needsChanges') =>
    reduce(implemented(), {
      type: 'verify-review.completed',
      targetId: candidate.id,
      passed: false,
      stdout: 'fail',
      exitCode: 1,
      log: null,
      reviews: null,
      failedCheckReviews: verdicts(decision).map((v) => ({
        ...v,
        findings: null,
      })),
    })

  it('is true after a review asked for changes, on its own or beside a failed check', () => {
    const reviewed = reduce(
      reduce(implemented(), {
        type: 'verify.completed',
        targetId: candidate.id,
        passed: true,
        stdout: 'ok',
        exitCode: 0,
      }),
      {
        type: 'review.completed',
        targetId: candidate.id,
        reviews: verdicts('needsChanges'),
      },
    )
    assert.equal(repairsReviewFeedback(reviewed), true)
    const both = failedBeside('needsChanges')
    // The notes are the check's alone; the reviews say what else to repair.
    assert.equal(both.repairNotes.length, 1)
    assert.match(both.repairNotes[0] ?? '', /^acceptance: /)
    assert.equal(repairsReviewFeedback(both), true)
  })

  it('is false before any review and after a failed check alone', () => {
    assert.equal(repairsReviewFeedback(initialState(setup)), false)
    assert.equal(repairsReviewFeedback(implemented()), false)
    const failed = reduce(implemented(), {
      type: 'verify.completed',
      targetId: candidate.id,
      passed: false,
      stdout: 'fail',
      exitCode: 1,
    })
    assert.equal(repairsReviewFeedback(failed), false)
    assert.equal(repairsReviewFeedback(failedBeside('pass')), false)
  })
})
