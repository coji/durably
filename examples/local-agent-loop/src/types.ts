/** Shared pipeline types. No logic here — see reducer.ts and policy.ts. */

export type Stage =
  | 'prepare'
  | 'implement'
  | 'test'
  | 'review'
  | 'aggregate'
  | 'approval'
  | 'finalize'

export type IterationResult = 'pass' | 'fail'

export interface ImplementOutcome {
  summary: string
  filesChanged: string[]
}

export interface TestOutcome {
  passed: boolean
  stdout: string
  exitCode: number | null
}

export interface ReviewVerdict {
  reviewer: 'review-a' | 'review-b'
  decision: 'pass' | 'needsChanges'
  notes: string
}

/** One completed review round (both reviewers reported). */
export interface ReviewRound {
  iteration: number
  reviews: ReviewVerdict[]
}

export type Conclusion =
  | 'approved'
  | 'rejected'
  | 'tests-failed'
  | 'review-cap-reached'
  | 'abandoned'

export interface PipelineState {
  stage: Stage
  iteration: number
  maxIterations: number
  implemented: ImplementOutcome[]
  tests: TestOutcome[]
  /** Latest completed review round (reset when the target changes). */
  reviews: ReviewVerdict[]
  /** All completed rounds, oldest first (audit trail, never reset). */
  reviewHistory: ReviewRound[]
  /** Review notes that the next implement iteration must address. */
  pendingReviewNotes: string[]
  approval: 'approved' | 'rejected' | null
  conclusion: Conclusion | null
  done: boolean
  failed: boolean
}

export function initialState(maxIterations: number): PipelineState {
  return {
    stage: 'prepare',
    iteration: 0,
    maxIterations,
    implemented: [],
    tests: [],
    reviews: [],
    reviewHistory: [],
    pendingReviewNotes: [],
    approval: null,
    conclusion: null,
    done: false,
    failed: false,
  }
}
