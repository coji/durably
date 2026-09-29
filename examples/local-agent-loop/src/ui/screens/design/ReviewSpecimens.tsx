import type { HighlightGroup, ReviewHighlights } from '../../../engine/report'
import { DESIGN } from '../../glossary'
import { ReviewHighlightsPanel } from '../run/ReviewsPanel'
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
 * The review highlights after a passed last round, with blockers still
 * open, and while a reviewer of the last round has no verdict yet.
 */
export function HighlightStates() {
  return (
    <>
      {HIGHLIGHTS.map(([state, h]) => (
        <State key={state} label={DESIGN.state[state]}>
          <ReviewHighlightsPanel h={h} />
        </State>
      ))}
    </>
  )
}
