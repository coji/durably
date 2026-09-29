import { formatCost, formatCount, formatDuration } from '../../engine/format'
import type { Task, TaskRun } from '../../engine/status'
import { Commands } from '../components/Commands'
import { EmptyState } from '../components/EmptyState'
import { Section } from '../components/Layout'
import { LiveProgress } from '../components/LiveProgress'
import { IdSuffix } from '../components/RunLink'
import { StageTrack } from '../components/StageTrack'
import { StatusBadge } from '../components/StatusBadge'
import { runState, TaskList, TaskRow } from '../components/TaskRow'
import { Ago } from '../components/Time'
import { COMMON, LIST } from '../glossary'
import { diagnosisText, retryLabel } from '../labels'
import type { RunRow, RunsResponse } from '../server'

const runHref = (id: string) => `#/runs/${encodeURIComponent(id)}`

/** Each run by its place in the task: the first run, then each repair. */
function roleLabels(runs: TaskRun[]): Map<string, string> {
  let repairs = 0
  return new Map(
    runs.map((r) => [
      r.id,
      r.parentId === null ? LIST.firstRun : LIST.repairRun(++repairs),
    ]),
  )
}

/** Every run of a task, oldest first, each by its place in the task. */
function TaskRuns({
  task,
  rows,
  now,
}: {
  task: Task
  rows: Map<string, RunRow>
  now: string
}) {
  const roles = roleLabels(task.runs)
  return (
    <ol className="border-line flex flex-col border-t">
      {task.runs.map((r) => {
        const row = rows.get(r.id)
        if (!row) return null
        const state = runState({
          ...row,
          kind: r.kind,
          superseded: r.superseded,
        })
        return (
          <li
            key={r.id}
            className="border-line flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-sm"
          >
            <StatusBadge label={state.label} tone={state.tone} />
            <span className="flex min-w-0 flex-1 basis-40 items-baseline gap-2">
              <a
                href={runHref(r.id)}
                className="text-fg decoration-line-strong underline underline-offset-2 hover:decoration-current"
              >
                {roles.get(r.id)}
              </a>
              <IdSuffix id={r.id} />
              {r.superseded ? (
                <span
                  title={LIST.supersededTitle}
                  className="text-fg-2 text-xs"
                >
                  {LIST.superseded}
                </span>
              ) : null}
            </span>
            <span className="text-fg-2 flex gap-3 text-xs tabular-nums">
              <span className="font-code">
                {formatDuration(row.leadTimeMs)}
              </span>
              <span className="font-code" title={COMMON.costNote}>
                {formatCost(row.costUsd)}
              </span>
              <Ago iso={row.createdAt} now={now} />
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The facts at the end of a task's line. */
function Meta({ task, rep, now }: { task: Task; rep: RunRow; now: string }) {
  const finished = task.attention === 'done'
  return (
    <>
      {task.runs.length > 1 ? (
        <span>{LIST.runs(formatCount(task.runs.length))}</span>
      ) : null}
      {finished ? (
        <>
          <span className="font-code">{formatDuration(rep.leadTimeMs)}</span>
          <span className="font-code" title={COMMON.costNote}>
            {formatCost(rep.costUsd)}
          </span>
        </>
      ) : null}
      <Ago iso={rep.createdAt} now={now} />
    </>
  )
}

/** One task: its run that shows it, why it is there, and the next step. */
function TaskItem({
  task,
  rows,
  now,
}: {
  task: Task
  rows: Map<string, RunRow>
  now: string
}) {
  const rep = rows.get(task.representative)
  const name = rows.get(task.id)?.name ?? rep?.name
  if (!rep || !name) return null
  const finished = task.attention === 'done'
  const running = rep.diagnosis.kind === 'running'
  return (
    <TaskRow
      status={runState({ ...rep, kind: rep.diagnosis.kind })}
      name={name}
      href={runHref(rep.id)}
      id={rep.id}
      meta={<Meta task={task} rep={rep} now={now} />}
      toggleLabel={LIST.showRuns(name)}
      defaultOpen={!finished}
    >
      <StageTrack pipeline={rep.pipeline} />
      {running ? <LiveProgress live={rep.live} /> : null}
      {finished ? null : (
        <>
          <p className="text-sm">
            {diagnosisText(rep.diagnosis, rep.uncertainCall)}
            {rep.diagnosis.failure ? (
              <span className="text-fg-2">
                {COMMON.separator}
                {LIST.retry}
                {retryLabel(rep.diagnosis.failure.retryable)}
              </span>
            ) : null}
          </p>
          <Commands lines={rep.diagnosis.next} />
        </>
      )}
      {task.runs.length > 1 ? (
        <TaskRuns task={task} rows={rows} now={now} />
      ) : null}
    </TaskRow>
  )
}

function Tasks({
  tasks,
  rows,
  now,
  empty,
}: {
  tasks: Task[]
  rows: Map<string, RunRow>
  now: string
  empty: string
}) {
  if (tasks.length === 0) return <EmptyState>{empty}</EmptyState>
  return (
    <TaskList>
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} rows={rows} now={now} />
      ))}
    </TaskList>
  )
}

/**
 * Tasks that wait on a person or stopped first, then tasks a worker has,
 * then finished ones, in the order the engine gave them. A first run and its
 * repairs are one row.
 */
export function RunsScreen({ data }: { data: RunsResponse }) {
  if (!data.exists)
    return (
      <EmptyState>
        {LIST.noDbBefore} <span className="font-code">{data.db}</span>{' '}
        {LIST.noDbAfter}
      </EmptyState>
    )
  const rows = new Map(data.runs.map((r) => [r.id, r]))
  const attention = data.tasks.filter(
    (t) => t.attention === 'decision' || t.attention === 'stop',
  )
  const active = data.tasks.filter((t) => t.attention === 'active')
  const done = data.tasks.filter((t) => t.attention === 'done')
  return (
    <>
      <Section title={LIST.attention} count={attention.length}>
        <Tasks
          tasks={attention}
          rows={rows}
          now={data.now}
          empty={LIST.attentionEmpty}
        />
      </Section>
      <Section title={LIST.active} count={active.length}>
        <Tasks
          tasks={active}
          rows={rows}
          now={data.now}
          empty={LIST.activeEmpty}
        />
      </Section>
      <Section title={LIST.done} count={done.length}>
        <Tasks tasks={done} rows={rows} now={data.now} empty={LIST.doneEmpty} />
      </Section>
    </>
  )
}
