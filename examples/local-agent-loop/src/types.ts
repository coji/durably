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

export interface PipelineState {
  stage: Stage
  iteration: number
  maxIterations: number
  implemented: ImplementOutcome[]
  tests: TestOutcome[]
  reviews: ReviewVerdict[]
  approval: 'approved' | 'rejected' | null
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
    approval: null,
    done: false,
    failed: false,
  }
}
