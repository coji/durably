import { useId } from 'react'

import type { AgentLog, VerificationLog } from '../../../engine/providers/types'
import {
  CHECKPOINT_NAME,
  COPY,
  DETAIL_TEXT,
  REVIEW,
  TRACE,
} from '../../glossary'
import { reviewDecision, reviewStatus } from '../../labels'
import type { TraceNode } from '../../server'
import { CopyAnnouncer, useCopy } from '../copy'
import { InlineField, InlineFields } from '../KeyValue'
import { LogWriteError, PathValue } from '../PathValue'
import { ReviewFindingTitles } from '../ReviewFindingTitles'
import { ReviewStatusMark } from '../ReviewStatusMark'
import { traceStatus } from '../status'
import { StatusBadge } from '../StatusBadge'
import { exactTime } from '../Time'
import { CheckLogBody, LiveLog, logUrl, type LogSource } from './AttemptLog'
import {
  CandidateFields,
  ProfileFields,
  TimingFields,
  UsageFields,
  WaitFields,
} from './InspectorFields'
import type { RunTotals } from './model'

/**
 * A review's verdict, notes and findings. One that ran beside a check the
 * candidate failed says so, with the reason, in place of or under its
 * verdict (ADR-0029).
 */
function ReviewBlock({ review }: { review: NonNullable<TraceNode['review']> }) {
  const verdict = reviewDecision(review.decision)
  const ended = reviewStatus(review.status)
  const cancelled = review.status === 'cancelled'
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm">
        {REVIEW.verdict}{' '}
        {cancelled ? (
          <span className="font-medium">{REVIEW.noVerdict}</span>
        ) : (
          <span className="font-medium" title={verdict.title}>
            {verdict.label}
          </span>
        )}
        <ReviewStatusMark status={review.status} />
      </p>
      {ended ? <p className="text-fg-2 text-xs">{ended.reason}</p> : null}
      {cancelled ? null : (
        <p className="bg-sunken max-h-48 overflow-auto rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
          {review.notes}
        </p>
      )}
      <ReviewFindingTitles findings={review.findings} />
    </div>
  )
}

/**
 * An agent call's output: its file, to copy, and its text, read while the
 * call runs.
 */
function AgentLogSlot({
  log,
  source,
}: {
  log: AgentLog
  source: LogSource | null
}) {
  const { copied, copy } = useCopy()
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="text-fg-2 text-xs font-medium">
        {TRACE.agentLog}
      </h4>
      <InlineFields>
        <InlineField label={TRACE.logFile}>
          <PathValue
            path={log.path}
            label={COPY.agentLogPath}
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
      {source ? <LiveLog url={logUrl(source, 'agent')} /> : null}
      <CopyAnnouncer copied={copied} />
    </section>
  )
}

/**
 * A verification row's full check output: file paths to copy, and the
 * stdout or stderr text.
 */
function LogSlot({
  log,
  source,
}: {
  log: VerificationLog
  source: LogSource | null
}) {
  const { copied, copy } = useCopy()
  // One per inspector: the design page draws several side by side.
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h4 id={headingId} className="text-fg-2 text-xs font-medium">
        {TRACE.log}
      </h4>
      <InlineFields>
        {log.interrupted ? (
          <InlineField label={TRACE.attempts}>
            {DETAIL_TEXT.interruptedCheck}
          </InlineField>
        ) : null}
        <InlineField label={TRACE.exitCode}>
          <span
            className="font-code"
            title={log.exitCode === null ? DETAIL_TEXT.noExitCode : undefined}
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
      {source ? <CheckLogBody source={source} /> : null}
      <CopyAnnouncer copied={copied} />
    </section>
  )
}

/** The row's agent output or check output, read from its attempt. */
function RowLogs({ node: n, runId }: { node: TraceNode; runId?: string }) {
  const source =
    runId && n.logAttemptId ? { runId, attemptId: n.logAttemptId } : null
  return (
    <>
      {n.agentLog ? <AgentLogSlot log={n.agentLog} source={source} /> : null}
      {n.verificationLog ? (
        <LogSlot log={n.verificationLog} source={source} />
      ) : null}
    </>
  )
}

/** The selected row's log first, then its stored details. */
export function TraceInspector({
  node: n,
  chosen,
  totals,
  elapsed,
  origin,
  runId,
}: {
  node: TraceNode
  chosen: boolean
  totals: RunTotals
  elapsed: number
  origin: string
  /** The run whose logs are read; absent on the design page. */
  runId?: string
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
      <RowLogs node={n} runId={runId} />
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
