/** Code policy: chooses the next development action, never file mechanics. */
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
