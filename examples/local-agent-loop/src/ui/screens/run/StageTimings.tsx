import { Fragment, type ReactNode } from 'react'

import { formatCost, formatDuration } from '../../../engine/format'
import type { LoopReport } from '../../../engine/report'
import { EmptyState } from '../../components/EmptyState'
import { PartialTag } from '../../components/KeyValue'
import { RunLink } from '../../components/RunLink'
import { Ago } from '../../components/Time'
import { BASELINE, COLUMN, COMMON, DETAIL, RUN_NAME } from '../../glossary'
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

/** Name, bar, work, wall and cost in the stage grid's five columns. */
function StageLine({
  name,
  title,
  share,
  work,
  wall,
  cost,
  className = '',
}: {
  name: string
  title?: string
  /** The bar's length from 0 to 1; no bar when absent. */
  share?: number
  work: ReactNode
  wall: ReactNode
  cost: ReactNode
  className?: string
}) {
  return (
    <li className={`stage-row items-center gap-3 text-sm ${className}`}>
      <span title={title}>{name}</span>
      <span className="stage-bar bg-sunken h-2 rounded-sm" aria-hidden>
        {share !== undefined ? (
          <span
            className="bg-fg-3/60 block h-full rounded-sm"
            style={{ width: `${share * 100}%` }}
          />
        ) : null}
      </span>
      <span className="font-code text-right">{work}</span>
      <span className="font-code text-fg-2 text-right">{wall}</span>
      <span className="font-code text-right">{cost}</span>
    </li>
  )
}

/**
 * Each stage's work, wall-clock time and cost on one line, the work as a
 * bar; the spec stages together by their wall time; the whole run last,
 * its work beside its lead time. A note says why work can exceed the lead
 * time.
 */
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
  const cost = (stage: string) => {
    const u = report.stageUsage.find((x) => x.stage === stage)
    return u ? formatCost(u.costUsd) : DETAIL.noCost
  }
  // A run with spec stages always has the spec stage itself.
  const spec = report.stageTimings.some((t) => t.stage === 'spec')
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        <li className="stage-row text-fg-2 gap-3 text-xs" aria-hidden>
          <span>{COLUMN.stage}</span>
          <span className="stage-bar" />
          <span className="text-right">{DETAIL.work}</span>
          <span className="text-right">{DETAIL.wall}</span>
          <span className="text-right" title={COMMON.costNote}>
            {COLUMN.cost}
          </span>
        </li>
        {report.stageTimings.map((t) => (
          <Fragment key={t.stage}>
            <StageLine
              name={stageName(t.stage)}
              share={(t.elapsedMs ?? 0) / max}
              work={
                <>
                  {formatDuration(t.elapsedMs)}
                  {t.elapsedMs == null || t.complete ? null : (
                    <PartialTag title={COMMON.partialTiming} />
                  )}
                </>
              }
              wall={formatDuration(t.wallElapsedMs)}
              cost={cost(t.stage)}
            />
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
        {spec ? (
          <StageLine
            name={DETAIL.specTogether}
            title={DETAIL.specTogetherTitle}
            work=""
            wall={formatDuration(report.specWallMs)}
            cost=""
            className="text-fg-2 border-line border-t pt-2"
          />
        ) : null}
        <StageLine
          name={DETAIL.stageTotal}
          work={formatDuration(report.stageTotalMs)}
          wall={formatDuration(report.summary.leadTimeMs)}
          cost={formatCost(report.summary.costUsd)}
          className="border-line border-t pt-2 font-medium"
        />
      </ul>
      <p className="text-fg-2 text-xs">{DETAIL.timeNote}</p>
    </div>
  )
}
