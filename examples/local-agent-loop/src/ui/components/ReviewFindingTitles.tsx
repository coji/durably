import { formatCount } from '../../engine/format'
import type { ReportReviewFindings } from '../../engine/report'
import { COMMON, REVIEW } from '../glossary'

/**
 * A findings review's count of each kind and the titles the report kept.
 * The body, file and line of each finding are read in the JSON report.
 */
export function ReviewFindingTitles({
  findings,
}: {
  findings: ReportReviewFindings | null
}) {
  if (!findings) return null
  const groups = [
    {
      label: REVIEW.blockers,
      kept: findings.blocker,
      count: findings.counts.blocker,
    },
    {
      label: REVIEW.advice,
      kept: findings.nonBlocker,
      count: findings.counts.nonBlocker,
    },
  ].map((g) => ({
    ...g,
    // The kept list never changes order, so its position is its identity.
    titles: g.kept.map((f, at) => ({
      id: `${f.severity}:${at}`,
      title: f.title,
    })),
  }))
  return (
    <div className="flex flex-col gap-2 text-sm">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-1">
          <p>
            <span className="font-medium">{g.label}</span>
            <span className="text-fg-2">
              {' '}
              {COMMON.count(formatCount(g.count))}
            </span>
          </p>
          {g.kept.length > 0 ? (
            <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-4">
              {g.titles.map((t) => (
                <li key={t.id}>{t.title}</li>
              ))}
            </ul>
          ) : null}
          {g.count > g.kept.length ? (
            <p className="text-fg-2">
              {REVIEW.omitted(formatCount(g.count - g.kept.length))}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
