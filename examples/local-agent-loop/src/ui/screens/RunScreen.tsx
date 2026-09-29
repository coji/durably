import type { Act } from '../components/ActionNotice'
import { CopyAnnouncer, CopyButton, useCopy } from '../components/copy'
import { Collapsible, Panel } from '../components/Layout'
import { StageTrack } from '../components/StageTrack'
import { StatusBadge } from '../components/StatusBadge'
import { ArchivedMark, SupersededMark } from '../components/SupersededMark'
import { TaskLineage } from '../components/TaskLineage'
import { runState } from '../components/TaskRow'
import { Ago } from '../components/Time'
import { TraceView } from '../components/trace/TraceView'
import { COMMON, COPY, DETAIL } from '../glossary'
import type { RunDetailResponse } from '../server'
import { RecordPanels } from './run/RecordPanels'
import { ReviewHighlightsPanel, ReviewsPanel } from './run/ReviewsPanel'
import { SpecPanel } from './run/SpecPanel'
import { StageTimings } from './run/StageTimings'
import { StatusPanel } from './run/StatusPanel'
import { tokensComplete, TriagePanel } from './run/SummaryPanel'
import { UsagePanels } from './run/UsagePanels'

/**
 * The run's one state, when it started, its ID, the other runs of its task
 * and its stages. The state is said once: how it ended, or where it is.
 */
function RunHeader({ data }: { data: RunDetailResponse }) {
  const r = data.report
  // A run a later approved repair made moot reads as the list and the
  // task's runs read it: in the quiet tone, with the word that says why.
  const superseded =
    data.lineage.find((l) => l.id === r.runId)?.superseded ?? false
  const state = runState({
    status: r.status,
    kind: data.diagnosis.kind,
    conclusion: r.summary.conclusion,
    superseded,
    archived: data.archived,
  })
  const { copied, copy } = useCopy()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge label={state.label} tone={state.tone} />
        {superseded ? <SupersededMark /> : null}
        {data.archived ? <ArchivedMark /> : null}
        <span className="text-fg-2 text-sm">
          <Ago
            iso={data.createdAt}
            now={data.now}
            prefix={`${COMMON.started} `}
          />
        </span>
        <code className="font-code text-fg-2 text-xs break-all">{r.runId}</code>
        <CopyButton
          text={r.runId}
          label={COPY.runId}
          copied={copied}
          onCopy={copy}
        />
        <CopyAnnouncer copied={copied} />
        {r.fake ? (
          <span className="text-fg-2 text-xs">{DETAIL.fake}</span>
        ) : null}
      </div>
      <TaskLineage runs={data.lineage} current={r.runId} now={data.now} />
      <StageTrack pipeline={data.pipeline} />
    </div>
  )
}

/**
 * Everything under the run's name, which the polled page renders as the h1,
 * in the order a person reads it and stops: the conclusion and next step,
 * what the reviews fixed and left, the stages over time with their time and
 * cost, and the evidence, closed.
 */
export function RunScreen({
  data,
  act,
}: {
  data: RunDetailResponse
  act: Act
}) {
  const r = data.report
  const totals = {
    leadTimeMs: r.summary.leadTimeMs,
    invocations: r.summary.llmInvocations,
    totalTokens: r.summary.totalTokens,
    costUsd: r.summary.costUsd,
    complete: tokensComplete(r),
  }
  return (
    <div className="flex flex-col gap-4">
      <RunHeader data={data} />
      <StatusPanel data={data} act={act} />
      <ReviewHighlightsPanel h={r.reviewHighlights} />
      <Panel title={DETAIL.trace}>
        <div className="flex flex-col gap-6">
          <TraceView trace={data.trace} totals={totals} serverNow={data.now} />
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{DETAIL.timeAndCost}</h3>
            <StageTimings
              report={r}
              baselineSource={data.baselineSource}
              now={data.now}
            />
          </div>
        </div>
      </Panel>
      <Collapsible title={DETAIL.evidence} note={DETAIL.evidenceNote} bare>
        <SpecPanel report={r} />
        <ReviewsPanel report={r} />
        <UsagePanels report={r} />
        <TriagePanel report={r} />
        <RecordPanels report={r} />
      </Collapsible>
    </div>
  )
}
