import { formatCount } from '../../../engine/format'
import type {
  HighlightGroup,
  HighlightVerdict,
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

/** A verdict review's round and lens: `2回目 正しさのレビュー`. */
function verdictReview(v: HighlightVerdict): string {
  return `${REVIEW.roundOf(v.round)} ${lensName(v.lens)}`
}

/** A verdict review with its decision, in the smaller type of a review. */
function VerdictLine({ v }: { v: HighlightVerdict }) {
  return (
    <>
      {verdictReview(v)}
      <span title={reviewDecision(v.decision).title}>
        {COMMON.separator}
        {reviewDecision(v.decision).label}
      </span>
    </>
  )
}

/**
 * One side of the highlights: how many findings, the first titles, the
 * verdicts. The count is the report's, findings only; verdict reviews are
 * listed below without being counted, so a group of verdicts alone shows
 * no count. A verdict under what was fixed names the change it asked for,
 * not its 要修正, which would read as still open.
 */
function Group({
  label,
  group,
  fixed,
}: {
  label: string
  group: HighlightGroup
  /** The rounds before a passed last round: their requests were fixed. */
  fixed?: boolean
}) {
  const titles = group.titles.slice(0, SHOWN)
  const rest = group.count - titles.length
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="flex items-baseline gap-2 text-sm font-semibold">
        {label}
        {group.count > 0 ? (
          <span className="text-fg-2 font-normal tabular-nums">
            {COMMON.count(formatCount(group.count))}
          </span>
        ) : null}
      </h3>
      {group.count === 0 && group.verdicts.length === 0 ? (
        <p className="text-fg-3 text-sm">{REVIEW.none}</p>
      ) : null}
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
        // Apart from the titles, in smaller type: a review, not a finding.
        <ul className="text-fg-2 flex flex-col gap-1 text-xs">
          {group.verdicts.map((v) => (
            <li key={`${v.round}:${v.lens}`}>
              {fixed ? (
                REVIEW.askedFor(verdictReview(v))
              ) : (
                <VerdictLine v={v} />
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * The reviews in short: what the rounds before the last blocked on, what
 * the last round left as advice, and what it still blocks on when it did
 * not pass. The earlier blockers read as fixed only once the last round
 * passed, with a verdict from every reviewer; before that they are only
 * earlier findings. Verdict reviews show their round, lens and verdict
 * only; each review's notes are in the evidence below.
 */
export function ReviewHighlightsPanel({ h }: { h: ReviewHighlights }) {
  // Before any review round the stage track already says so.
  if (h.rounds === 0) return null
  const passed = h.last === 'passed'
  const verdicts =
    h.lastPasses.length > 0 ||
    [h.earlier, h.left, h.open].some((g) => g.verdicts.length > 0)
  return (
    <Panel title={REVIEW.highlights}>
      <div className="flex flex-col gap-3">
        <div className="text-fg-2 flex flex-col gap-1 text-xs">
          <p>
            {REVIEW.rounds(formatCount(h.rounds))}
            {COMMON.separator}
            {passed
              ? REVIEW.passedLast
              : h.last === 'blocked'
                ? REVIEW.failedLast
                : REVIEW.incompleteLast}
          </p>
          {h.lastPasses.length > 0 ? (
            // The last round's passing verdicts: what it decided, not
            // something it left, so they sit with how it ended.
            <ul className="flex flex-col gap-1">
              {h.lastPasses.map((v) => (
                <li key={v.lens}>
                  <VerdictLine v={v} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div
          className={`grid gap-4 md:grid-cols-2 ${passed ? '' : 'lg:grid-cols-3'}`}
        >
          {passed ? null : <Group label={REVIEW.open} group={h.open} />}
          {passed ? (
            <Group label={REVIEW.fixed} group={h.earlier} fixed />
          ) : (
            <Group label={REVIEW.earlier} group={h.earlier} />
          )}
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
