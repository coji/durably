import { PIPELINE_SUFFIX } from '../glossary'
import { stageName } from '../labels'
import type { Pipeline, PipelineStage, PipelineState } from '../server'

const STAGE_CLASS: Record<PipelineState, string> = {
  done: 'text-fg',
  auto: 'text-fg',
  running: 'bg-running-bg text-running rounded-sm px-1 font-medium',
  waiting: 'bg-waiting-bg text-waiting rounded-sm px-1 font-medium',
  current: 'bg-sunken text-fg rounded-sm px-1 font-medium',
  stopped: 'bg-failed-bg text-failed rounded-sm px-1 font-medium',
  'not-reached': 'text-fg-3',
}

/** The mark of a stage the run passed. */
function Check() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="size-3 shrink-0">
      <path
        d="M2.5 6.5l2.25 2.25L9.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The quiet mark between two stages. */
function Next() {
  return (
    <svg aria-hidden viewBox="0 0 12 12" className="text-fg-3 size-3 shrink-0">
      <path
        d="M4.5 3l3 3-3 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One stage as the track shows it: its mark, name, count and state word. */
function StageChip({ s }: { s: PipelineStage }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap ${STAGE_CLASS[s.state]}`}
    >
      {s.state === 'running' ? (
        <span className="dot-live size-1.5 rounded-full bg-current" />
      ) : null}
      {s.state === 'done' || s.state === 'auto' ? <Check /> : null}
      {stageName(s.stage)}
      {s.count > 1 ? <span className="tabular-nums">×{s.count}</span> : null}
      {PIPELINE_SUFFIX[s.state] ? (
        <span className="font-normal">{PIPELINE_SUFFIX[s.state]}</span>
      ) : null}
    </span>
  )
}

/**
 * The run's stages in their fixed order, on one line where it fits. A done
 * stage carries a check mark, an approval the settings gave says 自動 too;
 * a stage without one was not reached. Screen
 * readers hear the server's one-sentence summary instead of the chips.
 */
export function StageTrack({ pipeline }: { pipeline: Pipeline }) {
  return (
    <div className="text-xs leading-5">
      <p className="sr-only">{pipeline.label}</p>
      <ol aria-hidden className="flex flex-wrap items-center gap-1">
        {pipeline.stages.map((s, i) => (
          <li key={s.stage} className="inline-flex items-center gap-1">
            {i > 0 ? <Next /> : null}
            <StageChip s={s} />
          </li>
        ))}
      </ol>
    </div>
  )
}
