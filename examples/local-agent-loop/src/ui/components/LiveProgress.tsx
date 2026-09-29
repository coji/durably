import { formatDuration } from '../../engine/format'
import type { LiveElapsed } from '../../engine/report'
import { COMMON, LIST } from '../glossary'
import { stageName } from '../labels'

/** The running stage, on a line of its own; the rest as secondary text. */
export function LiveProgress({
  live,
  extra,
}: {
  live: LiveElapsed | null
  extra?: string
}) {
  const rest = [
    live?.stage ? LIST.stageElapsed(formatDuration(live.stageMs)) : null,
    live ? LIST.runElapsed(formatDuration(live.runMs)) : null,
    extra || null,
  ]
    .filter(Boolean)
    .join(COMMON.separator)
  return (
    <div className="flex flex-col gap-1">
      <p className="text-fg text-sm font-medium tabular-nums">
        {live?.stage
          ? LIST.currentStage(stageName(live.stage))
          : LIST.betweenStages}
      </p>
      {rest ? <p className="text-fg-2 text-xs tabular-nums">{rest}</p> : null}
    </div>
  )
}
