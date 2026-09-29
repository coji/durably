import { formatCount } from '../../engine/format'
import type {
  HighlightGroup,
  HighlightVerdict,
  ReviewHighlights,
} from '../../engine/report'
import { COMMON, REVIEW } from '../glossary'
import { lensName, reviewDecision } from '../labels'

/** Titles shown per group before the rest is counted: full, then compact. */
const SHOWN = 5
const SHOWN_COMPACT = 3

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
 * not its 要修正, which would read as still open. Compact, it keeps the
 * count and fewer titles and leaves the verdicts out.
 */
function Group({
  label,
  group,
  fixed,
  compact,
}: {
  label: string
  group: HighlightGroup
  /** The rounds before a passed last round: their requests were fixed. */
  fixed?: boolean
  compact?: boolean
}) {
  const titles = group.titles.slice(0, compact ? SHOWN_COMPACT : SHOWN)
  const rest = group.count - titles.length
  const verdicts = compact ? [] : group.verdicts
  const Heading = compact ? 'p' : 'h3'
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Heading className="text-fg flex items-baseline gap-2 text-sm font-semibold">
        {label}
        {group.count > 0 ? (
          <span className="text-fg-2 font-normal tabular-nums">
            {COMMON.count(formatCount(group.count))}
          </span>
        ) : null}
      </Heading>
      {group.count === 0 && verdicts.length === 0 ? (
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
      {verdicts.length > 0 ? (
        // Apart from the titles, in smaller type: a review, not a finding.
        <ul className="text-fg-2 flex flex-col gap-1 text-xs">
          {verdicts.map((v) => (
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
 * only; each review's notes are in the evidence below. `compact` keeps
 * how the last round ended and the counts and first titles, for the
 * question before an approval.
 */
export function ReviewHighlightsBody({
  h,
  compact = false,
}: {
  h: ReviewHighlights
  compact?: boolean
}) {
  const passed = h.last === 'passed'
  const lastPasses = compact ? [] : h.lastPasses
  const verdicts =
    !compact &&
    (h.lastPasses.length > 0 ||
      [h.earlier, h.left, h.open].some((g) => g.verdicts.length > 0))
  return (
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
        {lastPasses.length > 0 ? (
          // The last round's passing verdicts: what it decided, not
          // something it left, so they sit with how it ended.
          <ul className="flex flex-col gap-1">
            {lastPasses.map((v) => (
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
        {passed ? null : (
          <Group label={REVIEW.open} group={h.open} compact={compact} />
        )}
        {passed ? (
          <Group
            label={REVIEW.fixed}
            group={h.earlier}
            fixed
            compact={compact}
          />
        ) : (
          <Group label={REVIEW.earlier} group={h.earlier} compact={compact} />
        )}
        <Group label={REVIEW.left} group={h.left} compact={compact} />
      </div>
      {verdicts ? (
        <p className="text-fg-2 text-xs">{REVIEW.notesInEvidence}</p>
      ) : null}
    </div>
  )
}
