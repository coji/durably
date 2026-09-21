/** Pure reducer: (state, event) => state. One small handler per event kind. */
import type { PipelineEvent } from './events.js'
import type { PipelineState } from './types.js'

type Handler = (s: PipelineState, e: PipelineEvent) => PipelineState

const onPrepared: Handler = (s) => ({
  ...s,
  stage: 'implement',
  iteration: 1,
})

const onImplemented: Handler = (s, e) => {
  if (e.kind !== 'implemented') return s
  // The target changed: prior verification and reviews are invalid.
  return {
    ...s,
    stage: 'test',
    implemented: [...s.implemented, e.outcome],
    tests: s.stage === 'aggregate' ? [] : s.tests,
    reviews: [],
  }
}

const onTested: Handler = (s, e) => {
  if (e.kind !== 'tested') return s
  const tests = [...s.tests, e.outcome]
  if (e.outcome.passed) return { ...s, stage: 'review', tests }
  if (s.iteration >= s.maxIterations)
    return { ...s, stage: 'finalize', tests, failed: true }
  return { ...s, stage: 'implement', iteration: s.iteration + 1, tests }
}

const onReviewsCollected: Handler = (s, e) => {
  if (e.kind !== 'reviewsCollected') return s
  return {
    ...s,
    stage: 'aggregate',
    reviews: e.reviews,
    reviewHistory: [
      ...s.reviewHistory,
      { iteration: s.iteration, reviews: e.reviews },
    ],
  }
}

const onFixRequested: Handler = (s, e) => {
  if (e.kind !== 'fixRequested') return s
  return {
    ...s,
    stage: 'implement',
    iteration: s.iteration + 1,
    pendingReviewNotes: [...s.pendingReviewNotes, ...e.notes],
    // Target is about to change: invalidate this round's verification.
    tests: [],
    reviews: [],
  }
}

const onApprovalDecided: Handler = (s, e) => {
  if (e.kind !== 'approvalDecided') return s
  return { ...s, stage: 'finalize', approval: e.decision }
}

const onFinalized: Handler = (s, e) => {
  if (e.kind !== 'finalized') return s
  return {
    ...s,
    stage: 'finalize',
    done: true,
    conclusion: e.conclusion,
    failed: e.conclusion !== 'approved',
  }
}

const onAbandoned: Handler = (s) => ({
  ...s,
  failed: true,
  done: true,
  conclusion: 'abandoned',
})

/** Lookup table keeps each transition isolated; no giant switch. */
const handlers: Record<PipelineEvent['kind'], Handler> = {
  prepared: onPrepared,
  implemented: onImplemented,
  tested: onTested,
  reviewsCollected: onReviewsCollected,
  fixRequested: onFixRequested,
  approvalDecided: onApprovalDecided,
  finalized: onFinalized,
  abandoned: onAbandoned,
}

export function reduce(
  state: PipelineState,
  event: PipelineEvent,
): PipelineState {
  return handlers[event.kind](state, event)
}
