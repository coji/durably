import type { ReactNode } from 'react'

import {
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
  UNKNOWN,
} from '../../../engine/format'
import type { LoopReport } from '../../../engine/report'
import { Field, PartialTag } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import {
  CALIBRATION_KEYS,
  CALIBRATION_NAME,
  COMMON,
  DETAIL,
} from '../../glossary'
import { triageName } from '../../labels'

/**
 * Whether the run's token total covers every call: it is the sum of the
 * stage totals, so it is partial when any stage's is.
 */
export function tokensComplete(report: LoopReport): boolean {
  return report.stageUsage.every((u) => u.complete)
}

/** One number of the summary line: quieter when it is not known. */
function Fact({
  label,
  value,
  title,
  children,
}: {
  label: string
  value: string
  title?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col" title={title}>
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd
        className={`font-code text-base font-semibold whitespace-nowrap ${value === UNKNOWN ? 'text-fg-3' : 'text-fg'}`}
      >
        {value}
        {children}
      </dd>
    </div>
  )
}

/**
 * The run's time and cost in one line: how long it took from trigger to
 * end, how much work its stages did, how long it waited on a person, and
 * what it cost. No result here: the badge above says it once. When the
 * work adds up to more than the lead time, one line under it says why.
 */
export function SummaryPanel({ report: r }: { report: LoopReport }) {
  const s = r.summary
  const workOverLead =
    s.workMs != null && s.leadTimeMs != null && s.workMs > s.leadTimeMs
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label={DETAIL.leadTime} value={formatDuration(s.leadTimeMs)} />
        <Fact
          label={DETAIL.workTime}
          value={formatDuration(s.workMs)}
          title={DETAIL.timeNote}
        />
        <Fact label={DETAIL.humanWait} value={formatDuration(s.humanWaitMs)} />
        <Fact
          label={DETAIL.cost}
          value={formatCost(s.costUsd)}
          title={COMMON.costNote}
        />
        <Fact label={DETAIL.totalTokens} value={formatTokens(s.totalTokens)}>
          {s.totalTokens == null || tokensComplete(r) ? null : (
            <PartialTag title={COMMON.partialUsage} />
          )}
        </Fact>
        <Fact
          label={DETAIL.repairsReviews}
          value={`${formatCount(s.repairs)} / ${formatCount(s.reviewRounds)}`}
        />
      </dl>
      {workOverLead ? (
        <p className="text-fg-2 text-xs">{DETAIL.workOverLead}</p>
      ) : null}
    </div>
  )
}

/** The shadow triage judgment and what it measured, for the evidence. */
export function TriagePanel({ report: r }: { report: LoopReport }) {
  if (!r.triage) return null
  return (
    <Panel title={DETAIL.triage}>
      <div className="text-fg-2 flex flex-col gap-1">
        <p className="text-fg text-sm">
          {triageName(r.triage.judgment)}
          {COMMON.separator}
          {r.triage.reason}
        </p>
        <p className="text-xs">{DETAIL.triageShadow}</p>
        <dl className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {CALIBRATION_KEYS.map((key) => (
            <Field key={key} label={CALIBRATION_NAME[key]}>
              {formatCount(r.triage?.calibration?.[key])}
            </Field>
          ))}
        </dl>
      </div>
    </Panel>
  )
}
