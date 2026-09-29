/** Code policy: chooses the next development action, never file mechanics. */
import { specBlockers, type SpecState } from './reducer.js'
import type { FactoryState, StageDecision, StageName } from './types.js'

export function availableActions(state: FactoryState): StageName[] {
  if (state.outcome) return []
  if (!state.candidate) return ['code']
  if (!state.verification || state.verification.targetId !== state.candidate.id)
    return ['verify']
  if (!state.verification.passed) {
    return state.iteration < state.setup.maxIterations ? ['code'] : ['stop']
  }
  if (state.reviews.length === 0) return ['review']
  if (state.reviews.some((review) => review.decision === 'needsChanges')) {
    return state.iteration < state.setup.maxIterations ? ['code'] : ['stop']
  }
  // With auto-approval the delivery is itself what a human reviews, so the
  // run does not hold a worker while waiting for a signal it will always get.
  if (state.setup.autoApprove) return ['finish']
  if (state.approval === null) return ['approve']
  return ['finish']
}

/**
 * Whether a review can still come after this stage in the run. From
 * approval, finish or stop on, none does, so nothing a review reads is kept
 * past that point.
 */
export function reviewCanFollow(stage: StageName): boolean {
  return stage === 'code' || stage === 'verify' || stage === 'review'
}

export function decide(state: FactoryState): StageDecision {
  const [stage] = availableActions(state)
  if (!stage) throw new Error('policy has no action for a non-terminal state')
  if (stage === 'code') {
    // A repair run starts from an approved candidate, so even its first code
    // stage is a repair; it counts against the run's own budget.
    if (state.iteration === 0 && state.setup.repairOf)
      return { stage, role: 'repair', reason: 'repair from outside findings' }
    return {
      stage,
      role: state.iteration === 0 ? 'implement' : 'repair',
      reason: state.iteration === 0 ? 'initial implementation' : 'repair',
    }
  }
  if (stage === 'stop') {
    return {
      stage,
      reason: state.verification?.passed
        ? 'review repair budget exhausted'
        : 'verification repair budget exhausted',
    }
  }
  return { stage, reason: `next required stage: ${stage}` }
}

export function assertAllowedDecision(
  state: FactoryState,
  decision: StageDecision,
): void {
  if (!availableActions(state).includes(decision.stage))
    throw new Error(`policy selected disallowed stage: ${decision.stage}`)
  if (decision.stage === 'code' && !decision.role)
    throw new Error('code decision requires implement or repair role')
}

/** What the spec stages do next. */
export type SpecAction =
  | 'author'
  | 'review'
  | 'fix'
  | 'wait'
  | 'confirm'
  | 'reject'

/**
 * The spec stages' next action. A spec is confirmed once a round has no
 * blocker, or a person approves it; a blocker is fixed while rounds remain,
 * and after the last round a person decides. A revise adds one fix and one
 * round, after which a remaining blocker waits for a person again.
 * Non-blocking findings never hold a spec back.
 */
export function specAction(state: SpecState): SpecAction {
  if (!state.version) return 'author'
  if (state.decision === 'rejected') return 'reject'
  if (state.decision === 'approved') return 'confirm'
  if (state.reviseNotes !== null) return 'fix'
  if (state.unreviewed) return 'review'
  if (specBlockers(state).length === 0) return 'confirm'
  return state.round < state.allowedRounds ? 'fix' : 'wait'
}
