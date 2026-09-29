import { useState } from 'react'

import { formatCount } from '../../engine/format'
import type { Task } from '../../engine/status'
import type { Act } from '../components/ActionNotice'
import { EmptyState } from '../components/EmptyState'
import { Section } from '../components/Layout'
import { LiveProgress } from '../components/LiveProgress'
import { RunActions } from '../components/RunActions'
import { runHref } from '../components/RunLink'
import { StageTrack } from '../components/StageTrack'
import { ArchivedMark } from '../components/SupersededMark'
import { runState, TaskList, TaskRow, TaskTotal } from '../components/TaskRow'
import { Ago } from '../components/Time'
import { COMMON, LIST } from '../glossary'
import { diagnosisText, retryLabel } from '../labels'
import type { RunRow, RunsResponse } from '../server'
import { TaskRuns } from './list/TaskRuns'

/**
 * The facts at the end of a task's line. A finished task shows its time and
 * cost over every run, marked as a total when it took more than one; an open
 * task shows that total only when it took more than one run.
 */
function Meta({ task, rep, now }: { task: Task; rep: RunRow; now: string }) {
  const finished = task.attention === 'done'
  const several = task.runs.length > 1
  return (
    <>
      {rep.archived ? <ArchivedMark /> : null}
      {several ? <span>{LIST.runs(formatCount(task.runs.length))}</span> : null}
      {finished || several ? (
        <TaskTotal total={task.total} several={several} />
      ) : null}
      <Ago iso={rep.createdAt} now={now} />
    </>
  )
}

/**
 * One task: its run that shows it, why it is there, and the next step with
 * the actions it allows. An archived task keeps its reason and offers its
 * way back, and so does each archived run among its runs. While one run's
 * action asks or works, the other runs' actions step aside.
 */
function TaskItem({
  task,
  rows,
  now,
  act,
}: {
  task: Task
  rows: Map<string, RunRow>
  now: string
  act: Act
}) {
  const [asking, setAsking] = useState<string | null>(null)
  const rep = rows.get(task.representative)
  const name = rows.get(task.id)?.name ?? rep?.name
  if (!rep || !name) return null
  const finished = task.attention === 'done' && !rep.archived
  // Held only while that run still shows its actions: an unarchived run
  // leaves the list before it can say it is done.
  const shows = (id: string) =>
    id === rep.id ? !finished : rows.get(id)?.archived === true
  const aside = asking !== null && shows(asking) ? asking : null
  const hear = (id: string, action: string | null) =>
    setAsking(action === null ? null : id)
  const running = rep.diagnosis.kind === 'running'
  return (
    <TaskRow
      status={runState({ ...rep, kind: rep.diagnosis.kind })}
      name={name}
      href={runHref(rep.id)}
      id={rep.id}
      meta={<Meta task={task} rep={rep} now={now} />}
      toggleLabel={LIST.showRuns(name)}
      defaultOpen={task.attention !== 'done'}
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
          {aside === null || aside === rep.id ? (
            <RunActions
              run={{ ...rep, name }}
              act={act}
              onAsking={(action) => hear(rep.id, action)}
            />
          ) : null}
        </>
      )}
      {task.runs.length > 1 ? (
        <TaskRuns
          task={task}
          rows={rows}
          now={now}
          name={name}
          act={act}
          aside={aside}
          onAsking={hear}
        />
      ) : null}
    </TaskRow>
  )
}

function Tasks({
  tasks,
  rows,
  now,
  empty,
  act,
}: {
  tasks: Task[]
  rows: Map<string, RunRow>
  now: string
  empty: string
  act: Act
}) {
  if (tasks.length === 0) return <EmptyState>{empty}</EmptyState>
  return (
    <TaskList>
      {tasks.map((task) => (
        <TaskItem key={task.id} task={task} rows={rows} now={now} act={act} />
      ))}
    </TaskList>
  )
}

/**
 * Tasks that wait on a person or stopped first, then tasks a worker has,
 * then finished ones, in the order the engine gave them. A first run and its
 * repairs are one row. Archived tasks are among the finished ones.
 */
export function RunsScreen({ data, act }: { data: RunsResponse; act: Act }) {
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
          act={act}
        />
      </Section>
      <Section title={LIST.active} count={active.length}>
        <Tasks
          tasks={active}
          rows={rows}
          now={data.now}
          empty={LIST.activeEmpty}
          act={act}
        />
      </Section>
      <Section title={LIST.done} count={done.length}>
        <Tasks
          tasks={done}
          rows={rows}
          now={data.now}
          empty={LIST.doneEmpty}
          act={act}
        />
      </Section>
    </>
  )
}
