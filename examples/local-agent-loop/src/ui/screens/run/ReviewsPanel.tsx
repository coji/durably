import { formatCount } from '../../../engine/format'
import type {
  HighlightGroup,
  LoopReport,
  ReviewHighlights,
} from '../../../engine/report'
import { EmptyState } from '../../components/EmptyState'
import { Panel } from '../../components/Layout'
import { ReviewFindingTitles } from '../../components/ReviewFindingTitles'
import { IdSuffix } from '../../components/RunLink'
import { COMMON, REVIEW } from '../../glossary'
import { lensName, reviewDecision } from '../../labels'

/** Titles shown per group before the rest is counted. */
const SHOWN = 5

/** Each review of a round: its name, verdict, finding titles, and its notes closed. */
export function ReviewVerdicts({
  reviews,
}: {
  reviews: LoopReport['reviews']
}) {
  return (
    <ul className="flex flex-col gap-3">
      {reviews.map((review) => (
        <li key={review.lens} className="flex flex-col gap-1">
          <p className="text-sm">
            <span className="font-medium">{lensName(review.lens)}</span>
            <span
              className="text-fg-2"
              title={reviewDecision(review.decision).title}
            >
              {COMMON.separator}
              {reviewDecision(review.decision).label}
            </span>
          </p>
          <ReviewFindingTitles findings={review.findings} />
          <details>
            <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center text-xs">
              {REVIEW.notes}
            </summary>
            <p className="bg-sunken rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
              {review.notes}
            </p>
          </details>
        </li>
      ))}
    </ul>
  )
}

/**
 * One side of the highlights: how many, the first titles, the verdicts.
 * A verdict under what was fixed names the change it asked for, not its
 * 要修正, which would read as still open.
 */
function Group({
  label,
  group,
  fixed,
}: {
  label: string
  group: HighlightGroup
  /** The rounds before the last, whose requests the run went on to fix. */
  fixed?: boolean
}) {
  const titles = group.titles.slice(0, SHOWN)
  const rest = group.count - titles.length
  const empty = group.count === 0 && group.verdicts.length === 0
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        {label}
        <span className="text-fg-2 font-normal tabular-nums">
          {COMMON.count(formatCount(group.count))}
        </span>
      </h3>
      {empty ? <p className="text-fg-3 text-sm">{REVIEW.none}</p> : null}
      {titles.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm">
          {titles.map((title, at) => (
            // A kept list never changes order, so its position is its identity.
            <li key={`${at}:${title}`}>{title}</li>
          ))}
        </ul>
      ) : null}
      {rest > 0 ? (
        <p className="text-fg-2 text-xs">{REVIEW.more(formatCount(rest))}</p>
      ) : null}
      {group.verdicts.length > 0 ? (
        // Apart from the titles, so the count above matches the bullets.
        <ul className="text-fg-2 flex flex-col gap-1 text-xs">
          {group.verdicts.map((v) => {
            const review = `${REVIEW.roundOf(v.round)} ${lensName(v.lens)}`
            return (
              <li key={`${v.round}:${v.lens}`}>
                {fixed ? (
                  REVIEW.askedFor(review)
                ) : (
                  <>
                    {review}
                    <span title={reviewDecision(v.decision).title}>
                      {COMMON.separator}
                      {reviewDecision(v.decision).label}
                    </span>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The reviews in short: what the rounds before the last made the run fix,
 * what the last round left as advice, and what it still blocked on when it
 * did not pass. Verdict reviews show their round, lens and verdict only;
 * each review's notes are in the evidence below.
 */
export function ReviewHighlightsPanel({ h }: { h: ReviewHighlights }) {
  // Before any review round the stage track already says so.
  if (h.rounds === 0) return null
  const verdicts = [h.fixed, h.left, h.open].some((g) => g.verdicts.length > 0)
  return (
    <Panel title={REVIEW.highlights}>
      <div className="flex flex-col gap-3">
        <p className="text-fg-2 text-xs">
          {REVIEW.rounds(h.rounds)}
          {COMMON.separator}
          {h.passed ? REVIEW.passedLast : REVIEW.failedLast}
        </p>
        <div
          className={`grid gap-4 md:grid-cols-2 ${h.passed ? '' : 'lg:grid-cols-3'}`}
        >
          {h.passed ? null : <Group label={REVIEW.open} group={h.open} />}
          <Group label={REVIEW.fixed} group={h.fixed} fixed />
          <Group label={REVIEW.left} group={h.left} />
        </div>
        {verdicts ? (
          <p className="text-fg-2 text-xs">{REVIEW.notesInEvidence}</p>
        ) : null}
      </div>
    </Panel>
  )
}

/**
 * Every review round in order, each with the candidate it reviewed. A run
 * whose report has no rounds shows its last verdicts only.
 */
export function ReviewsPanel({ report: r }: { report: LoopReport }) {
  const rounds = r.reviewRounds
  const sealedAs = (id: string) =>
    r.candidates.find((c) => c.id === id)?.iteration ?? null
  return (
    <Panel title={REVIEW.heading}>
      {rounds.length === 0 && r.reviews.length === 0 ? (
        <EmptyState>{REVIEW.empty}</EmptyState>
      ) : rounds.length === 0 ? (
        <ReviewVerdicts reviews={r.reviews} />
      ) : (
        <ol className="flex flex-col gap-6">
          {rounds.map((round) => {
            const sealed = round.candidate ? sealedAs(round.candidate.id) : null
            return (
              <li key={round.sequence} className="flex flex-col gap-2">
                <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                  <span>{REVIEW.round(round.round)}</span>
                  {round.candidate ? (
                    <span className="text-fg-2 inline-flex items-baseline gap-2 font-normal">
                      {sealed !== null
                        ? REVIEW.candidateOf(sealed)
                        : REVIEW.candidate}
                      <IdSuffix id={round.candidate.id} />
                    </span>
                  ) : null}
                </h3>
                <ReviewVerdicts reviews={round.reviews} />
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
