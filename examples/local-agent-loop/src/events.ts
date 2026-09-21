/** Domain events for the agent loop. Reducer consumes these; policy reads state. */
import type {
  Conclusion,
  ImplementOutcome,
  ReviewVerdict,
  TestOutcome,
} from './types.js'

export type PipelineEvent =
  | { kind: 'prepared' }
  | { kind: 'implemented'; outcome: ImplementOutcome }
  | { kind: 'tested'; outcome: TestOutcome }
  | { kind: 'reviewsCollected'; reviews: ReviewVerdict[] }
  | { kind: 'fixRequested'; notes: string[] }
  | { kind: 'approvalDecided'; decision: 'approved' | 'rejected' }
  | { kind: 'finalized'; conclusion: Conclusion }
  | { kind: 'abandoned'; reason: string }

export const prepared = (): PipelineEvent => ({ kind: 'prepared' })
export const implemented = (outcome: ImplementOutcome): PipelineEvent => ({
  kind: 'implemented',
  outcome,
})
export const tested = (outcome: TestOutcome): PipelineEvent => ({
  kind: 'tested',
  outcome,
})
export const reviewsCollected = (reviews: ReviewVerdict[]): PipelineEvent => ({
  kind: 'reviewsCollected',
  reviews,
})
/** A review round demanded changes: carry notes into the next fix. */
export const fixRequested = (notes: string[]): PipelineEvent => ({
  kind: 'fixRequested',
  notes,
})
export const approvalDecided = (
  decision: 'approved' | 'rejected',
): PipelineEvent => ({ kind: 'approvalDecided', decision })
export const finalized = (conclusion: Conclusion): PipelineEvent => ({
  kind: 'finalized',
  conclusion,
})
export const abandoned = (reason: string): PipelineEvent => ({
  kind: 'abandoned',
  reason,
})
