/**
 * Policy: read-only decisions derived from state, plus the Stage registry
 * the runner executes. The runner loop is strictly:
 *
 *   Policy decides (persisted to a `policy:<n>` step) -> Stage runs ->
 *   Event updates state.
 *
 * No stage runs without a persisted policy decision behind it, so recovery
 * reuses the recorded decision instead of re-deriving it.
 */
import type { Conclusion, PipelineState, Stage } from './types.js'

export type NextAction =
  | { action: 'implement'; iteration: number }
  | { action: 'review' }
  | { action: 'requestApproval' }
  | { action: 'finalize'; conclusion: Conclusion }
  | { action: 'wait' }

/** Stage registry: policy action -> executable stage descriptor. */
export interface StageSpec {
  readonly stage: Stage
  /** Durably step names owned by this stage (per iteration where noted). */
  stepNames(iteration: number): string[]
}

const STAGES: Record<string, StageSpec> = {
  implement: {
    stage: 'implement',
    stepNames: (iteration) => [`implement:${iteration}`, `test:${iteration}`],
  },
  review: {
    stage: 'review',
    stepNames: (iteration) => [
      `review-a:${iteration}`,
      `review-b:${iteration}`,
    ],
  },
  requestApproval: {
    stage: 'approval',
    stepNames: () => ['human-approval'],
  },
  finalize: {
    stage: 'finalize',
    stepNames: () => ['finalize-report'],
  },
}

export function stageFor(action: NextAction): StageSpec | null {
  if (action.action === 'wait') return null
  return STAGES[action.action] ?? null
}

const nextByStage: Record<Stage, (s: PipelineState) => NextAction> = {
  prepare: () => ({ action: 'wait' }),
  implement: (s) => ({ action: 'implement', iteration: s.iteration }),
  test: () => ({ action: 'wait' }),
  review: () => ({ action: 'review' }),
  aggregate: (s) => {
    const needsChanges = s.reviews.some((r) => r.decision === 'needsChanges')
    const testsPassed = lastTestPassed(s)
    if (!needsChanges && testsPassed) return { action: 'requestApproval' }
    if (needsChanges && s.iteration < s.maxIterations) {
      return { action: 'implement', iteration: s.iteration + 1 }
    }
    if (needsChanges) {
      // Fix budget exhausted: terminal, but NOT approval and NOT success.
      return { action: 'finalize', conclusion: 'review-cap-reached' }
    }
    return { action: 'finalize', conclusion: 'tests-failed' }
  },
  approval: () => ({ action: 'wait' }),
  finalize: (s) => ({
    action: 'finalize',
    conclusion: s.conclusion ?? (s.failed ? 'tests-failed' : 'approved'),
  }),
}

export function lastTestPassed(s: PipelineState): boolean {
  return s.tests.length > 0 && s.tests[s.tests.length - 1]?.passed === true
}

export function decideNext(state: PipelineState): NextAction {
  return nextByStage[state.stage](state)
}

export function shouldFixAgain(state: PipelineState): boolean {
  if (state.tests.length === 0) return true
  const last = state.tests[state.tests.length - 1]
  return !last?.passed && state.iteration < state.maxIterations
}

/** Review findings that the next implement iteration must address. */
export function pendingFixNotes(state: PipelineState): string[] {
  return state.reviews
    .filter((r) => r.decision === 'needsChanges')
    .map((r) => `${r.reviewer}: ${r.notes}`)
}
