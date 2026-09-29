import {
  formatCost,
  formatCount,
  formatDuration,
  formatTokens,
} from '../../../engine/format'
import type { LoopReport } from '../../../engine/report'
import { Field, PartialTag } from '../../components/KeyValue'
import { Panel } from '../../components/Layout'
import { conclusionStatus } from '../../components/status'
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

export function SummaryPanel({ report: r }: { report: LoopReport }) {
  const s = r.summary
  return (
    <Panel title={DETAIL.summary}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label={DETAIL.result}>
          {s.conclusion ? conclusionStatus(s.conclusion).label : COMMON.notYet}
        </Field>
        <Field label={DETAIL.leadTime}>{formatDuration(s.leadTimeMs)}</Field>
        <Field label={DETAIL.workTime}>{formatDuration(s.workMs)}</Field>
        <Field label={DETAIL.humanWait}>{formatDuration(s.humanWaitMs)}</Field>
        <Field label={DETAIL.totalTokens}>
          {formatTokens(s.totalTokens)}
          {s.totalTokens == null || tokensComplete(r) ? null : (
            <PartialTag title={COMMON.partialUsage} />
          )}
        </Field>
        <Field label={DETAIL.cost}>{formatCost(s.costUsd)}</Field>
        <Field label={DETAIL.repairsReviews}>
          {s.repairs} / {s.reviewRounds}
        </Field>
        <Field label={DETAIL.triage}>
          <span className="font-ui">
            {r.triage ? triageName(r.triage.judgment) : COMMON.none}
          </span>
        </Field>
      </dl>
      {r.triage ? (
        <div className="text-fg-2 mt-3 flex flex-col gap-1">
          <p className="text-sm">{r.triage.reason}</p>
          <p className="text-xs">{DETAIL.triageShadow}</p>
          <dl className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {CALIBRATION_KEYS.map((key) => (
              <Field key={key} label={CALIBRATION_NAME[key]}>
                {formatCount(r.triage?.calibration?.[key])}
              </Field>
            ))}
          </dl>
        </div>
      ) : null}
    </Panel>
  )
}
