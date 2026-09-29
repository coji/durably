import { useId } from 'react'

import type { VerificationLog } from '../../../engine/providers/types'
import {
  CHECKPOINT_NAME,
  COPY,
  DETAIL_TEXT,
  REVIEW,
  TRACE,
} from '../../glossary'
import { reviewDecision } from '../../labels'
import type { TraceNode } from '../../server'
import { CopyAnnouncer, useCopy } from '../copy'
import { InlineField, InlineFields } from '../KeyValue'
import { LogWriteError, PathValue } from '../PathValue'
import { ReviewFindingTitles } from '../ReviewFindingTitles'
import { traceStatus } from '../status'
import { StatusBadge } from '../StatusBadge'
import { exactTime } from '../Time'
import {
  CandidateFields,
  ProfileFields,
  TimingFields,
  UsageFields,
  WaitFields,
} from './InspectorFields'
import type { RunTotals } from './model'

function ReviewBlock({ review }: { review: NonNullable<TraceNode['review']> }) {
  const verdict = reviewDecision(review.decision)
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        {REVIEW.verdict}{' '}
        <span className="font-medium" title={verdict.title}>
          {verdict.label}
        </span>
      </p>
      <p className="bg-sunken max-h-48 overflow-auto rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
        {review.notes}
      </p>
      <ReviewFindingTitles findings={review.findings} />
    </div>
  )
}

/**
 * The row's log: a verification row's full check output as file paths, or
 * the reserved slot for an agent log, which is not read in yet.
 */
function LogSlot({ log }: { log: VerificationLog | null }) {
  const { copied, copy } = useCopy()
  // One per inspector: the design page draws several side by side.
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h4 id={headingId} className="text-fg-2 text-xs font-medium">
        {TRACE.log}
      </h4>
      {log ? (
        <>
          <InlineFields>
            {log.interrupted ? (
              <InlineField label={TRACE.attempts}>
                {DETAIL_TEXT.interruptedCheck}
              </InlineField>
            ) : null}
            <InlineField label={TRACE.exitCode}>
              <span
                className="font-code"
                title={
                  log.exitCode === null ? DETAIL_TEXT.noExitCode : undefined
                }
              >
                {log.exitCode ?? 'null'}
              </span>
            </InlineField>
            <InlineField label={TRACE.stdout}>
              <PathValue
                path={log.stdoutPath}
                label={COPY.stdoutPath}
                copied={copied}
                onCopy={copy}
              />
            </InlineField>
            <InlineField label={TRACE.stderr}>
              <PathValue
                path={log.stderrPath}
                label={COPY.stderrPath}
                copied={copied}
                onCopy={copy}
              />
            </InlineField>
            {log.writeError ? (
              <InlineField label={TRACE.writeError}>
                <LogWriteError error={log.writeError} />
              </InlineField>
            ) : null}
          </InlineFields>
          <CopyAnnouncer copied={copied} />
        </>
      ) : (
        <p className="border-line-strong text-fg-3 rounded-md border border-dashed px-3 py-2 text-xs">
          {TRACE.logLater}
        </p>
      )}
    </section>
  )
}

/** The selected row's stored details, and the slot where logs will go. */
export function TraceInspector({
  node: n,
  chosen,
  totals,
  elapsed,
  origin,
}: {
  node: TraceNode
  chosen: boolean
  totals: RunTotals
  elapsed: number
  origin: string
}) {
  const state = traceStatus(n.state)
  const heading = chosen ? TRACE.chosen : n.open ? TRACE.following : TRACE.pick
  return (
    <aside
      aria-label={TRACE.inspector}
      className="border-line flex min-w-0 flex-col gap-3 rounded-md border p-3"
    >
      <div className="flex flex-col gap-1">
        <p className="text-fg-3 text-xs">{heading}</p>
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <span className="break-all">{n.label}</span>
          <StatusBadge label={state.label} tone={state.tone} />
        </h3>
      </div>
      <InlineFields>
        <TimingFields
          node={n}
          elapsed={elapsed}
          leadTimeMs={totals.leadTimeMs}
        />
        {n.profile ? <ProfileFields profile={n.profile} /> : null}
        {n.kind === 'run' ? (
          // The whole run shows the report's own totals.
          <UsageFields u={totals} />
        ) : n.usage ? (
          <UsageFields u={n.usage} />
        ) : null}
        {n.checkpoint ? (
          <InlineField label={TRACE.checkpoint}>
            {CHECKPOINT_NAME[n.checkpoint]}
          </InlineField>
        ) : null}
        {n.candidate ? <CandidateFields candidate={n.candidate} /> : null}
        {n.wait ? (
          <WaitFields node={n} wait={n.wait} elapsed={elapsed} />
        ) : null}
      </InlineFields>
      {n.stage === 'review' && n.kind === 'entry' && n.review ? (
        <ReviewBlock review={n.review} />
      ) : null}
      <LogSlot log={n.verificationLog} />
      <p className="text-fg-3 text-xs">
        {TRACE.clockBefore}
        <time dateTime={origin} title={exactTime(origin)}>
          {TRACE.clockOrigin}
        </time>
        {TRACE.clockAfter}
      </p>
    </aside>
  )
}
