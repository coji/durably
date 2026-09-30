import type {
  HighlightGroup,
  LoopReport,
  ReviewHighlights,
} from '../../../engine/report'
import { DESIGN } from '../../glossary'
import { ReviewHighlightsPanel, ReviewsPanel } from '../run/ReviewsPanel'
import { State } from './Specimen'

/** Finding titles and verdicts as the report keeps them; data, as stored. */
const group = (
  titles: string[],
  verdicts: HighlightGroup['verdicts'] = [],
): HighlightGroup => ({ count: titles.length, titles, verdicts })

const EARLIER = group(
  ['The cost column still prints six decimals'],
  [{ round: 1, lens: 'edge-cases', decision: 'needsChanges', line: '' }],
)
const LEFT = group(['Name the rounding rule in the README'])
const OPEN = group(['A negative cost still prints as $-0.00'])

const HIGHLIGHTS: [keyof typeof DESIGN.state, ReviewHighlights][] = [
  [
    'reviewPassed',
    {
      rounds: 2,
      last: 'passed',
      // A verdict-mode reviewer that passed: shown with how the round
      // ended, neither counted nor listed as left.
      lastPasses: [
        { round: 2, lens: 'edge-cases', decision: 'pass', line: '' },
      ],
      earlier: EARLIER,
      left: LEFT,
      open: group([]),
    },
  ],
  [
    'reviewOpen',
    {
      rounds: 2,
      last: 'blocked',
      lastPasses: [],
      earlier: EARLIER,
      left: LEFT,
      open: OPEN,
    },
  ],
  [
    'reviewIncomplete',
    {
      rounds: 2,
      last: 'incomplete',
      lastPasses: [],
      earlier: EARLIER,
      left: LEFT,
      open: group([]),
    },
  ],
]

/**
 * Reviews run beside the check (ADR-0029): a round the failed check ended,
 * one whose verdicts came before the failure, and the one that counted.
 */
const BESIDE_CHECK = {
  reviews: [],
  candidates: [],
  reviewRounds: [
    {
      round: 1,
      sequence: 1,
      candidate: null,
      status: 'cancelled',
      reason: 'superseded-by-verify',
      reviews: [
        {
          lens: 'correctness',
          decision: '',
          notes: '',
          findings: null,
          status: 'cancelled',
          reason: 'superseded-by-verify',
        },
        {
          lens: 'edge-cases',
          decision: 'needsChanges',
          notes: 'Division by zero is still left undefined.',
          findings: null,
          status: 'discarded',
          reason: 'verify-failed',
        },
      ],
    },
    {
      round: 2,
      sequence: 4,
      candidate: null,
      status: 'completed',
      reason: null,
      reviews: [
        { lens: 'correctness', decision: 'pass', notes: '', findings: null },
        { lens: 'edge-cases', decision: 'pass', notes: '', findings: null },
      ],
    },
  ],
  discardedReviews: {
    invocations: 2,
    inputTokens: 18_400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 900,
    totalTokens: 19_300,
    costUsd: 0.31,
    complete: true,
    costComplete: true,
  },
} as unknown as LoopReport

/**
 * The review highlights after a passed last round, with blockers still
 * open, and while a reviewer of the last round has no verdict yet; then
 * the rounds of reviews run beside a check the candidate failed.
 */
export function HighlightStates() {
  return (
    <>
      {HIGHLIGHTS.map(([state, h]) => (
        <State key={state} label={DESIGN.state[state]}>
          <ReviewHighlightsPanel h={h} />
        </State>
      ))}
      <State label={DESIGN.state.reviewDiscarded}>
        <ReviewsPanel report={BESIDE_CHECK} />
      </State>
    </>
  )
}
