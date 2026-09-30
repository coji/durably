/** Pure factory state reducer. */
import type { FactoryEvent, SpecEvent } from './events.js'
import { specBlockerText } from './prompts.js'
import type { FactoryState, SpecReviewResult, SpecVersion } from './types.js'

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
        failedCheckReviews: [],
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
          log: event.log ?? null,
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
    case 'verify-review.completed': {
      if (event.targetId !== state.candidate?.id)
        throw new Error(`verification target is stale: ${event.targetId}`)
      const verification = {
        targetId: event.targetId,
        passed: event.passed,
        stdout: event.stdout,
        exitCode: event.exitCode,
        log: event.log,
      }
      // A failed check hands its output to the repair first. The reviews
      // of a candidate that failed are neither kept nor counted; those that
      // completed go to the repair apart, after the check failure.
      if (!event.passed)
        return {
          ...state,
          verification,
          reviews: [],
          repairNotes: [`acceptance: ${event.stdout.slice(-1000)}`],
          failedCheckReviews: event.failedCheckReviews ?? [],
        }
      if (!event.reviews)
        throw new Error(
          `a passing verification of ${event.targetId} has no reviews`,
        )
      return {
        ...state,
        verification,
        reviews: event.reviews,
        reviewRounds: state.reviewRounds + 1,
        repairNotes: event.reviews
          .filter((review) => review.decision === 'needsChanges')
          .map((review) => `${review.lens}: ${review.notes}`),
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

/** Where the spec stages stand; see `specAction` for what comes next. */
export interface SpecState {
  /** The spec as last written; null before the author ran. */
  version: SpecVersion | null
  /** Review rounds run so far. */
  round: number
  /** The rounds allowed before a person decides; grows by one per revise. */
  allowedRounds: number
  /** The last round's results. */
  reviews: SpecReviewResult[]
  /** The version as last written has not been reviewed yet. */
  unreviewed: boolean
  /** The blocker notes of earlier rounds a fix already addressed. */
  settled: string[]
  /** Spec-blocked waits so far. */
  waits: number
  /** A person decided on a blocked spec: its approval or rejection. */
  decision: 'approved' | 'rejected' | null
  /** A person's notes for the next fix; null when none is pending. */
  reviseNotes: string | null
}

export function initialSpecState(maxRounds: number): SpecState {
  return {
    version: null,
    round: 0,
    allowedRounds: maxRounds,
    reviews: [],
    unreviewed: false,
    settled: [],
    waits: 0,
    decision: null,
    reviseNotes: null,
  }
}

/** The blocking reviews of the last round, one note line per reviewer. */
export function specBlockers(state: SpecState): SpecReviewResult[] {
  return state.reviews.filter((r) => r.decision === 'needsChanges')
}

export function reduceSpec(state: SpecState, event: SpecEvent): SpecState {
  switch (event.type) {
    case 'spec.authored':
      return { ...state, version: event.version, unreviewed: true }
    case 'spec.fixed':
      return {
        ...state,
        version: event.version,
        unreviewed: true,
        // What this fix addressed is settled for the reviews that follow.
        settled: [
          ...state.settled,
          ...specBlockers(state).map((r) => `${r.name}: ${specBlockerText(r)}`),
        ],
        reviseNotes: null,
      }
    case 'spec.reviewed':
      if (event.sha256 !== state.version?.sha256)
        throw new Error(`spec review target is stale: ${event.sha256}`)
      return {
        ...state,
        round: state.round + 1,
        reviews: event.reviews,
        unreviewed: false,
      }
    case 'spec.decided':
      if (event.sha256 !== state.version?.sha256)
        throw new Error(`spec decision target is stale: ${event.sha256}`)
      return event.decision === 'revise'
        ? {
            ...state,
            waits: state.waits + 1,
            // One more fix, then one more review round.
            allowedRounds: state.round + 1,
            reviseNotes: event.notes ?? '',
          }
        : { ...state, waits: state.waits + 1, decision: event.decision }
  }
}
