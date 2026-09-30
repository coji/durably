import type { ReviewStatus } from '../../engine/report'
import { reviewStatus } from '../labels'

/**
 * The word beside a review or round whose verdict did not count, with why
 * on hover (ADR-0029), after a space; nothing for one that counted. The
 * reviews panel and the trace inspector both use it.
 */
export function ReviewStatusMark({ status }: { status?: ReviewStatus | null }) {
  const shown = reviewStatus(status)
  if (!shown) return null
  return (
    <>
      {' '}
      <span
        title={shown.reason}
        className="text-fg-2 text-xs font-normal whitespace-nowrap"
      >
        {shown.label}
      </span>
    </>
  )
}
