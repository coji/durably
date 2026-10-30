import { formatDuration } from '../../engine/format'
import type { LiveElapsed } from '../../engine/report'
import { COMMON, LIST } from '../glossary'
import { stageName } from '../labels'

/**
 * The running stage, on a line of its own; the rest as secondary text.
 * `inline` puts it all on one line, for a list row's summary.
 */
export function LiveProgress({
  live,
  inline,
}: {
  live: LiveElapsed | null
  inline?: boolean
}) {
  const rest = [
    live?.stage ? LIST.stageElapsed(formatDuration(live.stageMs)) : null,
    live ? LIST.runElapsed(formatDuration(live.runMs)) : null,
  ]
    .filter(Boolean)
    .join(COMMON.separator)
  const stage = live?.stage
    ? LIST.currentStage(stageName(live.stage))
    : LIST.betweenStages
  if (inline)
    return (
      <span className="tabular-nums">
        <span className="text-fg font-medium">{stage}</span>
        {rest ? `${COMMON.separator}${rest}` : null}
      </span>
    )
  return (
    <div className="flex flex-col gap-1">
      <p className="text-fg text-sm font-medium tabular-nums">{stage}</p>
      {rest ? <p className="text-fg-2 text-xs tabular-nums">{rest}</p> : null}
    </div>
  )
}
