import { CopyAnnouncer, CopyButton, useCopy } from '../components/copy'
import { Panel } from '../components/Layout'
import { RelationLinks } from '../components/RunLink'
import { StageTrack } from '../components/StageTrack'
import { kindStatus } from '../components/status'
import { StatusBadge } from '../components/StatusBadge'
import { Ago } from '../components/Time'
import { TraceView } from '../components/trace/TraceView'
import { COMMON, COPY, DETAIL } from '../glossary'
import type { RunDetailResponse } from '../server'
import { RecordPanels } from './run/RecordPanels'
import { ReviewsPanel } from './run/ReviewsPanel'
import { SpecPanel } from './run/SpecPanel'
import { StageTimings } from './run/StageTimings'
import { StatusPanel } from './run/StatusPanel'
import { SummaryPanel, tokensComplete } from './run/SummaryPanel'
import { UsagePanels } from './run/UsagePanels'

/** The run's state, when it started, its full ID and its stages. */
function RunHeader({ data }: { data: RunDetailResponse }) {
  const r = data.report
  const kind = kindStatus(data.diagnosis.kind)
  const { copied, copy } = useCopy()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge label={kind.label} tone={kind.tone} />
        <span className="text-fg-2 text-sm">
          <Ago
            iso={data.createdAt}
            now={data.now}
            prefix={`${COMMON.started} `}
          />
        </span>
        {r.fake ? (
          <span className="text-fg-2 text-xs">{DETAIL.fake}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-fg-2 text-xs">{DETAIL.runId}</span>
        <code className="font-code text-fg-2 text-xs break-all">{r.runId}</code>
        <CopyButton
          text={r.runId}
          label={COPY.runId}
          copied={copied}
          onCopy={copy}
        />
        <CopyAnnouncer copied={copied} />
      </div>
      <RelationLinks relations={data.relations} />
      <StageTrack pipeline={data.pipeline} />
    </div>
  )
}

/** Everything under the run's name, which the polled page renders as the h1. */
export function RunScreen({ data }: { data: RunDetailResponse }) {
  const r = data.report
  const totals = {
    leadTimeMs: r.summary.leadTimeMs,
    invocations: r.summary.llmInvocations,
    totalTokens: r.summary.totalTokens,
    costUsd: r.summary.costUsd,
    complete: tokensComplete(r),
  }
  return (
    <div className="flex flex-col gap-6">
      <RunHeader data={data} />
      <StatusPanel data={data} />
      <SummaryPanel report={r} />
      <Panel title={DETAIL.trace}>
        <TraceView trace={data.trace} totals={totals} serverNow={data.now} />
      </Panel>
      <Panel title={DETAIL.stageTimes}>
        <StageTimings
          report={r}
          baselineSource={data.baselineSource}
          now={data.now}
        />
      </Panel>
      <UsagePanels report={r} />
      <SpecPanel report={r} />
      <ReviewsPanel report={r} />
      <RecordPanels report={r} />
    </div>
  )
}
