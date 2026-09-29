import { Fragment } from 'react'

import { formatDuration } from '../../../engine/format'
import type { LoopReport } from '../../../engine/report'
import { EmptyState } from '../../components/EmptyState'
import { PartialTag } from '../../components/KeyValue'
import { RunLink } from '../../components/RunLink'
import { Ago } from '../../components/Time'
import { BASELINE, COMMON, DETAIL, RUN_NAME } from '../../glossary'
import { stageName } from '../../labels'
import type { RunRef } from '../../server'

/**
 * Where the baseline verdict came from: the check run here, or another
 * run's passing result used in its place, with that run and when its check
 * completed. Nothing while the baseline has no verdict.
 */
export function BaselineSource({
  baseline,
  source,
  now,
}: {
  baseline: LoopReport['baseline']
  /** The reused run's name, from the detail response; null if it no longer exists. */
  source: RunRef | null
  now: string
}) {
  if (!baseline || baseline.passed === null) return null
  const from = baseline.reusedFrom
  if (!from) return <p className="text-fg-2 text-xs">{BASELINE.measured}</p>
  return (
    <div className="text-fg-2 flex flex-col gap-1 text-xs">
      <p>{BASELINE.reused}</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <dt>{BASELINE.source}</dt>
          <dd className="min-w-0">
            <RunLink id={from.runId} name={source?.name ?? RUN_NAME.previous} />
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt>{BASELINE.checkedAt}</dt>
          <dd>
            <Ago iso={from.checkedAt} now={now} />
          </dd>
        </div>
      </dl>
      {baseline.logMissing ? <p>{BASELINE.logMissing}</p> : null}
    </div>
  )
}

/** Each stage's working time as a bar, longest first in scale. */
export function StageTimings({
  report,
  baselineSource,
  now,
}: {
  report: LoopReport
  baselineSource: RunRef | null
  now: string
}) {
  const max = Math.max(1, ...report.stageTimings.map((t) => t.elapsedMs ?? 0))
  if (report.stageTimings.length === 0)
    return <EmptyState>{DETAIL.stageTimesEmpty}</EmptyState>
  return (
    <ul className="flex flex-col gap-2">
      {report.stageTimings.map((t) => (
        <Fragment key={t.stage}>
          <li className="stage-row items-center gap-3">
            <span className="text-sm">{stageName(t.stage)}</span>
            <span className="bg-sunken h-2 rounded-sm" aria-hidden>
              <span
                className="bg-fg-3/60 block h-full rounded-sm"
                style={{ width: `${((t.elapsedMs ?? 0) / max) * 100}%` }}
              />
            </span>
            <span className="font-code text-right text-sm">
              {formatDuration(t.elapsedMs)}
              {t.elapsedMs == null || t.complete ? null : (
                <PartialTag title={COMMON.partialTiming} />
              )}
            </span>
          </li>
          {t.stage === 'baseline' && report.baseline?.passed != null ? (
            <li className="stage-row-note gap-3">
              <span />
              <BaselineSource
                baseline={report.baseline}
                source={baselineSource}
                now={now}
              />
            </li>
          ) : null}
        </Fragment>
      ))}
      <li className="border-line stage-row gap-3 border-t pt-2 text-sm">
        <span>{DETAIL.stageTotal}</span>
        <span />
        <span className="font-code text-right">
          {formatDuration(report.stageTotalMs)}
        </span>
      </li>
    </ul>
  )
}
