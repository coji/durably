import { formatCost, formatCount } from '../../../engine/format'
import type { LoopReport, ReviewHighlights } from '../../../engine/report'
import { EmptyState } from '../../components/EmptyState'
import { InlineField, InlineFields } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { ReviewFindingTitles } from '../../components/ReviewFindingTitles'
import { ReviewHighlightsBody } from '../../components/ReviewHighlights'
import { ReviewStatusMark } from '../../components/ReviewStatusMark'
import { IdSuffix } from '../../components/RunLink'
import { COMMON, REVIEW } from '../../glossary'
import { lensName, reviewDecision, reviewStatus } from '../../labels'

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
            {review.status === 'cancelled' ? (
              <span className="text-fg-2">
                {COMMON.separator}
                {REVIEW.noVerdict}
              </span>
            ) : (
              <span
                className="text-fg-2"
                title={reviewDecision(review.decision).title}
              >
                {COMMON.separator}
                {reviewDecision(review.decision).label}
              </span>
            )}
            <ReviewStatusMark status={review.status} />
          </p>
          <ReviewFindingTitles findings={review.findings} />
          {review.status === 'cancelled' ? null : (
            <details>
              <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center text-xs">
                {REVIEW.notes}
              </summary>
              <p className="bg-sunken rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
                {review.notes}
              </p>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The reviews in short, as the detail page shows them. */
export function ReviewHighlightsPanel({ h }: { h: ReviewHighlights }) {
  // Before any review round the stage track already says so.
  if (h.rounds === 0) return null
  return (
    <Panel title={REVIEW.highlights}>
      <ReviewHighlightsBody h={h} />
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
            const ended = reviewStatus(round.status)
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
                  <ReviewStatusMark status={round.status} />
                </h3>
                {ended ? (
                  <p className="text-fg-2 text-xs">{ended.reason}</p>
                ) : null}
                <ReviewVerdicts reviews={round.reviews} />
              </li>
            )
          })}
        </ol>
      )}
      {r.discardedReviews ? (
        <div className="mt-4">
          <InlineFields>
            <InlineField label={REVIEW.discardedCost}>
              <span title={`${REVIEW.discardedCostNote}${COMMON.costNote}`}>
                {REVIEW.discardedCalls(
                  formatCount(r.discardedReviews.invocations),
                )}
                {COMMON.separator}
                {formatCost(r.discardedReviews.costUsd)}
              </span>
            </InlineField>
          </InlineFields>
        </div>
      ) : null}
    </Panel>
  )
}
