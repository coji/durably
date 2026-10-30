import {
  formatCost,
  formatDuration,
  formatTokens,
  UNKNOWN,
} from '../../../engine/format'
import { DataTable, Td, Th } from '../../components/DataTable'
import {
  Field,
  InlineField,
  InlineFields,
  PartialTag,
} from '../../components/KeyValue'
import { Collapsible } from '../../components/Layout'
import { LiveProgress } from '../../components/LiveProgress'
import { MetricCard, MetricGrid } from '../../components/MetricCard'
import { RunLink } from '../../components/RunLink'
import { StageNow, StageTrack } from '../../components/StageTrack'
import { StatusBadge } from '../../components/StatusBadge'
import { FakeMark } from '../../components/SupersededMark'
import { TaskList, TaskMeta, TaskRow } from '../../components/TaskRow'
import { LogBody } from '../../components/trace/AttemptLog'
import { TraceView } from '../../components/trace/TraceView'
import {
  COLUMN,
  COMMON,
  DESIGN,
  DETAIL,
  DIAGNOSIS_TEXT,
  FAILURE_TEXT,
  KIND_NAME,
  TRACE,
} from '../../glossary'
import { MULTI_RUN, NOW, PIPELINES, TASK_ROWS, USAGE } from './fixtures'
import { State } from './Specimen'
import { LOG_VIEWS, TOTALS, TRACES } from './trace-fixtures'

const at = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()

export function TaskRowStates() {
  const [first] = TASK_ROWS
  return (
    <>
      <State label={DESIGN.state.open}>
        <TaskList>
          <TaskRow
            status={first.status}
            name={first.task.name}
            href="#/design"
            id={first.task.id}
            stage={<StageNow pipeline={first.pipeline} />}
            meta={<TaskMeta runs={1} at={at(first.minutes)} now={NOW} />}
            summary={DIAGNOSIS_TEXT.approval}
            toggleLabel={first.task.name}
            defaultOpen
          >
            <StageTrack pipeline={first.pipeline} />
          </TaskRow>
        </TaskList>
      </State>
      <State label={DESIGN.state.closed}>
        <TaskList>
          {TASK_ROWS.slice(1).map((r) => {
            const finished = r.status.tone === 'done'
            return (
              <TaskRow
                key={r.task.id}
                status={r.status}
                name={r.task.name}
                href="#/design"
                id={r.task.id}
                marks={r.fake ? <FakeMark /> : null}
                stage={finished ? null : <StageNow pipeline={r.pipeline} />}
                toggleLabel={r.task.name}
                meta={
                  <TaskMeta
                    runs={1}
                    leadTimeMs={finished ? 1_200_000 : undefined}
                    costUsd={finished ? USAGE.known.costUsd : undefined}
                    at={at(r.minutes)}
                    now={NOW}
                  />
                }
                summary={
                  finished ? null : r.status.tone === 'running' ? (
                    <LiveProgress
                      live={{
                        stage: 'code',
                        stepName: null,
                        stageMs: 184_000,
                        runMs: 720_000,
                      }}
                      inline
                    />
                  ) : (
                    FAILURE_TEXT['review-cap-reached'].reason
                  )
                }
              >
                <StageTrack pipeline={r.pipeline} />
              </TaskRow>
            )
          })}
        </TaskList>
      </State>
      <State label={DESIGN.state.total}>
        <TaskList>
          {MULTI_RUN.map((r) => (
            <TaskRow
              key={r.task.id}
              status={r.status}
              name={r.task.name}
              href="#/design"
              id={r.task.id}
              toggleLabel={r.task.name}
              meta={
                <TaskMeta
                  runs={r.runs}
                  leadTimeMs={r.total.leadTimeMs}
                  costUsd={r.total.costUsd}
                  at={at(r.minutes)}
                  now={NOW}
                />
              }
            >
              <StageTrack pipeline={PIPELINES[r.pipeline]} />
            </TaskRow>
          ))}
        </TaskList>
      </State>
    </>
  )
}

export function StageTrackStates() {
  return (
    <>
      {(
        [
          ['waiting', 'approval'],
          ['stopped', 'stopped'],
          ['running', 'running'],
          ['current', 'lease-expired'],
          ['done', 'finished'],
        ] as const
      ).map(([key, kind]) => (
        <State key={key} label={KIND_NAME[kind]}>
          <StageTrack pipeline={PIPELINES[key]} />
        </State>
      ))}
      <State label={DESIGN.state.autoApproved}>
        <StageTrack pipeline={PIPELINES.autoApproved} />
      </State>
    </>
  )
}

export function MetricStates() {
  return (
    <MetricGrid>
      <MetricCard
        label={DETAIL.cost}
        value={formatCost(USAGE.known.costUsd)}
        note={DESIGN.state.known}
      />
      <MetricCard
        label={DETAIL.totalTokens}
        value={formatTokens(USAGE.partial.totalTokens)}
        partial={COMMON.partialUsage}
        note={DESIGN.state.partial}
      />
      <MetricCard
        label={DETAIL.humanWait}
        value={formatDuration(null)}
        note={DESIGN.state.unknown}
      />
      <MetricCard
        label={DETAIL.leadTime}
        value={formatDuration(1_093_000)}
        note={DESIGN.sample.metricNote}
      />
    </MetricGrid>
  )
}

export function KeyValueStates() {
  return (
    <>
      <State label={DESIGN.state.stacked}>
        <dl className="grid grid-cols-2 gap-4">
          <Field label={DETAIL.leadTime}>{formatDuration(1_093_000)}</Field>
          <Field label={DETAIL.cost}>{formatCost(USAGE.known.costUsd)}</Field>
          <Field label={DETAIL.totalTokens}>
            {formatTokens(USAGE.partial.totalTokens)}
            <PartialTag title={COMMON.partialUsage} />
          </Field>
          <Field label={DETAIL.humanWait}>{UNKNOWN}</Field>
        </dl>
      </State>
      <State label={DESIGN.state.inline}>
        <InlineFields>
          <InlineField label={TRACE.model}>
            <span className="font-code">gpt-5.6-sol</span>
          </InlineField>
          <InlineField label={TRACE.effort}>
            <span className="font-code">{COMMON.defaultSetting}</span>
          </InlineField>
          <InlineField label={TRACE.cost}>
            <span className="font-code">{formatCost(0.0004)}</span>
          </InlineField>
        </InlineFields>
      </State>
    </>
  )
}

function SampleTable({ framed }: { framed?: boolean }) {
  const cells = [USAGE.known, USAGE.partial, USAGE.unknown]
  return (
    <DataTable
      framed={framed}
      head={
        <>
          <Th>{COLUMN.task}</Th>
          <Th>{COLUMN.result}</Th>
          <Th num>{COLUMN.totalTokens}</Th>
          <Th num>{COLUMN.cost}</Th>
        </>
      }
    >
      {TASK_ROWS.slice(1).map((r, i) => (
        <tr key={r.task.id}>
          <Td>
            <RunLink id={r.task.id} name={r.task.name} />
          </Td>
          <Td>
            <StatusBadge label={r.status.label} tone={r.status.tone} />
          </Td>
          <Td num>
            {formatTokens(cells[i]?.totalTokens)}
            {cells[i]?.complete || cells[i]?.totalTokens == null ? null : (
              <PartialTag title={COMMON.partialUsage} />
            )}
          </Td>
          <Td num>{formatCost(cells[i]?.costUsd)}</Td>
        </tr>
      ))}
    </DataTable>
  )
}

export function TableStates() {
  return (
    <>
      <State label={DESIGN.state.framed}>
        <SampleTable framed />
      </State>
      <State label={DESIGN.state.bare}>
        <SampleTable />
      </State>
    </>
  )
}

export function CollapsibleStates() {
  return (
    <>
      <State label={DESIGN.state.closed}>
        <Collapsible title={DESIGN.sample.section} count={2}>
          <p className="text-sm">{DIAGNOSIS_TEXT.approval}</p>
        </Collapsible>
      </State>
      <State label={DESIGN.state.open}>
        <Collapsible title={DESIGN.sample.section} count={2} defaultOpen>
          <p className="text-sm">{DIAGNOSIS_TEXT.approval}</p>
        </Collapsible>
      </State>
    </>
  )
}

export function TraceStates() {
  return (
    <>
      <State label={KIND_NAME.running}>
        <TraceView trace={TRACES.running} totals={TOTALS} serverNow={NOW} />
      </State>
      <State label={KIND_NAME.approval}>
        <TraceView trace={TRACES.waiting} totals={TOTALS} serverNow={NOW} />
      </State>
      {LOG_VIEWS.map(({ label, view }) => (
        <State key={label} label={label}>
          <LogBody view={view} />
        </State>
      ))}
    </>
  )
}
