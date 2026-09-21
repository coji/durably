/** Policy: read-only decisions derived from state. No mutations here. */
import type { PipelineState, Stage } from './types.js'

export type NextAction =
  | { action: 'implement'; iteration: number }
  | { action: 'review' }
  | { action: 'requestApproval' }
  | { action: 'finalize'; ok: boolean }
  | { action: 'wait' }

const nextByStage: Record<Stage, (s: PipelineState) => NextAction> = {
  prepare: () => ({ action: 'wait' }),
  implement: (s) => ({ action: 'implement', iteration: s.iteration }),
  test: () => ({ action: 'wait' }),
  review: () => ({ action: 'review' }),
  aggregate: (s) => {
    const needsChanges = s.reviews.some((r) => r.decision === 'needsChanges')
    if (needsChanges && s.iteration < s.maxIterations && !lastTestPassed(s))
      return { action: 'implement', iteration: s.iteration + 1 }
    if (needsChanges && lastTestPassed(s)) return { action: 'requestApproval' }
    if (needsChanges) return { action: 'finalize', ok: false }
    return { action: 'requestApproval' }
  },
  approval: () => ({ action: 'wait' }),
  finalize: (s) => ({ action: 'finalize', ok: !s.failed }),
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
