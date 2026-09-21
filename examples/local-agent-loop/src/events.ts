/** Domain events for the agent loop. Reducer consumes these; policy reads state. */
import type { ImplementOutcome, ReviewVerdict, TestOutcome } from './types.js'

export type PipelineEvent =
  | { kind: 'prepared' }
  | { kind: 'implemented'; outcome: ImplementOutcome }
  | { kind: 'tested'; outcome: TestOutcome }
  | { kind: 'reviewsCollected'; reviews: ReviewVerdict[] }
  | { kind: 'approvalDecided'; decision: 'approved' | 'rejected' }
  | { kind: 'finalized' }
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
export const approvalDecided = (
  decision: 'approved' | 'rejected',
): PipelineEvent => ({ kind: 'approvalDecided', decision })
export const finalized = (): PipelineEvent => ({ kind: 'finalized' })
export const abandoned = (reason: string): PipelineEvent => ({
  kind: 'abandoned',
  reason,
})
