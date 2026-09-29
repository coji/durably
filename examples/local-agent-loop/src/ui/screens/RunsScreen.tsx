import { formatCost, formatDuration } from '../../engine/format'
import { TERMINAL_STATUSES } from '../../engine/terminal'
import { Commands } from '../components/Commands'
import { DataTable, Td, Th } from '../components/DataTable'
import { EmptyState } from '../components/EmptyState'
import { Section } from '../components/Layout'
import { LiveProgress } from '../components/LiveProgress'
import { RelationLinks, RunLink } from '../components/RunLink'
import { StageTrack } from '../components/StageTrack'
import { conclusionStatus, kindStatus } from '../components/status'
import { StatusBadge } from '../components/StatusBadge'
import { Ago } from '../components/Time'
import { COLUMN, COMMON, LIST } from '../glossary'
import { diagnosisText, retryLabel, triageName } from '../labels'
import type { RunRow, RunsResponse } from '../server'

/** An open or stopped run, with its reason and next commands. */
function OpenRun({ run, now }: { run: RunRow; now: string }) {
  const kind = kindStatus(run.diagnosis.kind)
  const progress = [
    run.iterations > 0 ? LIST.iteration(run.iterations) : null,
    run.reviewRounds > 0 ? LIST.reviewRounds(run.reviewRounds) : null,
  ]
    .filter(Boolean)
    .join(COMMON.separator)
  const running = run.diagnosis.kind === 'running'
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge label={kind.label} tone={kind.tone} />
        <h3 className="min-w-0 text-sm">
          <RunLink id={run.id} name={run.name} />
        </h3>
        <span className="text-fg-2 ml-auto text-xs">
          <Ago iso={run.createdAt} now={now} prefix={`${COMMON.started} `} />
        </span>
      </div>
      <RelationLinks relations={run.relations} />
      <StageTrack pipeline={run.pipeline} />
      {running ? <LiveProgress live={run.live} extra={progress} /> : null}
      <p className="text-fg-2 text-sm">
        {diagnosisText(run.diagnosis, run.uncertainCall)}
      </p>
      {!running && progress ? (
        <p className="text-fg-2 text-xs tabular-nums">{progress}</p>
      ) : null}
      {run.diagnosis.failure ? (
        <p className="text-fg-2 text-xs">
          {LIST.retry}
          {retryLabel(run.diagnosis.failure.retryable)}
        </p>
      ) : null}
      <Commands lines={run.diagnosis.next} />
    </li>
  )
}

function OpenList({ runs, now }: { runs: RunRow[]; now: string }) {
  return (
    <ul className="divide-line border-line bg-raised divide-y rounded-lg border">
      {runs.map((run) => (
        <OpenRun key={run.id} run={run} now={now} />
      ))}
    </ul>
  )
}

function FinishedTable({ runs, now }: { runs: RunRow[]; now: string }) {
  return (
    <DataTable
      framed
      head={
        <>
          <Th>{COLUMN.task}</Th>
          <Th>{COLUMN.result}</Th>
          <Th num>{COLUMN.leadTime}</Th>
          <Th num title={COMMON.costNote}>
            {COLUMN.cost}
          </Th>
          <Th>{COLUMN.triage}</Th>
          <Th>{COLUMN.started}</Th>
        </>
      }
    >
      {runs.map((run) => {
        const c = conclusionStatus(run.conclusion ?? run.status)
        return (
          <tr key={run.id}>
            <Td>
              <span className="flex max-w-md flex-col gap-1">
                <RunLink id={run.id} name={run.name} />
                <RelationLinks relations={run.relations} />
                <StageTrack pipeline={run.pipeline} />
              </span>
            </Td>
            <Td>
              <StatusBadge label={c.label} tone={c.tone} />
            </Td>
            <Td num>{formatDuration(run.leadTimeMs)}</Td>
            <Td num>{formatCost(run.costUsd)}</Td>
            <Td>
              {run.triage ? (
                triageName(run.triage)
              ) : (
                <span className="text-fg-2">{COMMON.none}</span>
              )}
            </Td>
            <Td>
              <span className="text-fg-2 text-xs whitespace-nowrap">
                <Ago iso={run.createdAt} now={now} />
              </span>
            </Td>
          </tr>
        )
      })}
    </DataTable>
  )
}

/** Runs that need a person first, then open runs, then finished ones. */
export function RunsScreen({ data }: { data: RunsResponse }) {
  if (!data.exists)
    return (
      <EmptyState>
        {LIST.noDbBefore} <span className="font-code">{data.db}</span>{' '}
        {LIST.noDbAfter}
      </EmptyState>
    )
  const human = data.runs.filter((r) => r.needsHuman)
  const open = data.runs.filter(
    (r) => !r.needsHuman && !TERMINAL_STATUSES.includes(r.status),
  )
  const finished = data.runs.filter((r) => TERMINAL_STATUSES.includes(r.status))
  return (
    <>
      <Section title={LIST.human} count={human.length}>
        {human.length > 0 ? (
          <OpenList runs={human} now={data.now} />
        ) : (
          <EmptyState>{LIST.humanEmpty}</EmptyState>
        )}
      </Section>
      <Section title={LIST.open} count={open.length}>
        {open.length > 0 ? (
          <OpenList runs={open} now={data.now} />
        ) : (
          <EmptyState>{LIST.openEmpty}</EmptyState>
        )}
      </Section>
      <Section title={LIST.finished} count={finished.length}>
        {finished.length > 0 ? (
          <FinishedTable runs={finished} now={data.now} />
        ) : (
          <EmptyState>{LIST.finishedEmpty}</EmptyState>
        )}
      </Section>
    </>
  )
}
