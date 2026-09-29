import { PIPELINE_SUFFIX } from '../glossary'
import { stageName } from '../labels'
import type { Pipeline, PipelineState } from '../server'

const STAGE_CLASS: Record<PipelineState, string> = {
  done: 'text-fg',
  running: 'bg-running-bg text-running rounded-sm px-1 font-medium',
  waiting: 'bg-waiting-bg text-waiting rounded-sm px-1 font-medium',
  current: 'bg-sunken text-fg rounded-sm px-1 font-medium',
  stopped: 'bg-failed-bg text-failed rounded-sm px-1 font-medium',
  'not-reached': 'text-fg-3',
}

/**
 * The run's stages in their fixed order, on one line where it fits. A done
 * stage carries a check mark; a stage without one was not reached. Screen
 * readers hear the server's one-sentence summary instead of the chips.
 */
export function StageTrack({ pipeline }: { pipeline: Pipeline }) {
  return (
    <div className="text-xs leading-5">
      <p className="sr-only">{pipeline.label}</p>
      <ol aria-hidden className="flex flex-wrap items-center gap-1">
        {pipeline.stages.map((s, i) => (
          <li key={s.stage} className="inline-flex items-center gap-1">
            {i > 0 ? <span className="text-fg-3">›</span> : null}
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap ${STAGE_CLASS[s.state]}`}
            >
              {s.state === 'running' ? (
                <span className="dot-live size-1.5 rounded-full bg-current" />
              ) : null}
              {s.state === 'done' ? <span>✓</span> : null}
              {stageName(s.stage)}
              {s.count > 1 ? (
                <span className="tabular-nums">×{s.count}</span>
              ) : null}
              {PIPELINE_SUFFIX[s.state] ? (
                <span className="font-normal">{PIPELINE_SUFFIX[s.state]}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
