/** Pure factory state reducer. */
import type { FactoryEvent } from './events.js'
import type { FactoryState } from './types.js'

export function reduce(state: FactoryState, event: FactoryEvent): FactoryState {
  switch (event.type) {
    case 'code.completed':
      return {
        ...state,
        iteration: state.iteration + 1,
        candidate: event.candidate,
        implementationSession: event.session,
        verification: null,
        reviews: [],
        approval: null,
        repairNotes: [],
      }
    case 'verify.completed':
      if (event.targetId !== state.candidate?.id)
        throw new Error(`verification target is stale: ${event.targetId}`)
      return {
        ...state,
        verification: {
          targetId: event.targetId,
          passed: event.passed,
          stdout: event.stdout,
          exitCode: event.exitCode,
        },
        repairNotes: event.passed
          ? state.repairNotes
          : [`acceptance: ${event.stdout.slice(-1000)}`],
      }
    case 'review.completed': {
      if (event.targetId !== state.candidate?.id)
        throw new Error(`review target is stale: ${event.targetId}`)
      const notes = event.reviews
        .filter((review) => review.decision === 'needsChanges')
        .map((review) => `${review.lens}: ${review.notes}`)
      return {
        ...state,
        reviews: event.reviews,
        reviewRounds: state.reviewRounds + 1,
        repairNotes: notes,
      }
    }
    case 'approval.completed':
      if (event.targetId !== state.candidate?.id)
        throw new Error(`approval target is stale: ${event.targetId}`)
      return { ...state, approval: event.decision }
    case 'factory.finished':
      return { ...state, outcome: event.outcome }
  }
}
