import { useState } from 'react'

import type { Task } from '../../../engine/status'
import type { Act } from '../../components/ActionNotice'
import { EmptyState } from '../../components/EmptyState'
import { LiveProgress } from '../../components/LiveProgress'
import { RunActions } from '../../components/RunActions'
import { runHref } from '../../components/RunLink'
import { StageNow, StageTrack } from '../../components/StageTrack'
import { TONE_TEXT } from '../../components/status'
import { ArchivedMark, FakeMark } from '../../components/SupersededMark'
import {
  runRole,
  runState,
  TaskList,
  TaskMeta,
  TaskRow,
} from '../../components/TaskRow'
import { COMMON, LIST } from '../../glossary'
import { diagnosisText, retryLabel } from '../../labels'
import type { RunRow } from '../../server'
import { TaskRuns } from './TaskRuns'

/**
 * The facts at the end of a task's line. A finished task shows its time and
 * cost over every run; an open task shows them only when it took more than
 * one run, since its own run has none settled yet.
 */
function Meta({ task, rep, now }: { task: Task; rep: RunRow; now: string }) {
  const settled = task.attention === 'done' || task.runs.length > 1
  return (
    <TaskMeta
      runs={task.runs.length}
      leadTimeMs={settled ? task.total.leadTimeMs : undefined}
      costUsd={settled ? task.total.costUsd : undefined}
      at={rep.createdAt}
      now={now}
    />
  )
}

/**
 * The line under a task's name: a running run's stage, or why it waits.
 * When another run of the task is running, such as a retried repair under
 * a stopped one, that run leads, by its place in the task, and the reason
 * of the run that shows the task follows.
 */
function Summary({
  task,
  rep,
  rows,
}: {
  task: Task
  rep: RunRow
  rows: Map<string, RunRow>
}) {
  if (rep.diagnosis.kind === 'running')
    return <LiveProgress live={rep.live} inline />
  const why = diagnosisText(rep.diagnosis, rep.uncertainCall)
  const other = task.runs.find((r) => r.kind === 'running')
  const live = other ? rows.get(other.id) : undefined
  if (!other || !live) return <>{why}</>
  return (
    <>
      <span className={`${TONE_TEXT.running} font-medium`}>
        {LIST.otherRunning(runRole(other))}
      </span>
      {COMMON.separator}
      <LiveProgress live={live.live} inline />
      {COMMON.separator}
      {why}
    </>
  )
}

/** Words beside the ID: archived, and a finished rehearsal on the fake. */
function Marks({ task, rep }: { task: Task; rep: RunRow }) {
  return (
    <>
      {rep.archived ? <ArchivedMark /> : null}
      {task.attention === 'done' && task.fake ? <FakeMark /> : null}
    </>
  )
}

/**
 * What an open task offers: whether a retry is safe, and its actions,
 * unless another run of the task is asking.
 */
function NextStep({
  rep,
  name,
  act,
  hidden,
  onAsking,
}: {
  rep: RunRow
  name: string
  act: Act
  /** Another run's action asks or works. */
  hidden: boolean
  onAsking: (action: string | null) => void
}) {
  const failure = rep.diagnosis.failure
  return (
    <>
      {failure ? (
        <p className="text-fg-2 text-sm">
          {LIST.retry}
          {retryLabel(failure.retryable)}
        </p>
      ) : null}
      {hidden ? null : (
        <RunActions
          key={rep.id}
          run={{ ...rep, name }}
          act={act}
          onAsking={onAsking}
        />
      )}
    </>
  )
}

/**
 * One task: its run that shows it, where it stands, and why, on the row;
 * opening it shows the stages, the next step with the actions it allows,
 * and every run it took. An archived task keeps its reason and offers its
 * way back, and so does each archived run among its runs. While one run's
 * action asks or works, the other runs' actions step aside.
 */
function TaskItem({
  task,
  rows,
  now,
  act,
  defaultOpen,
}: {
  task: Task
  rows: Map<string, RunRow>
  now: string
  act: Act
  defaultOpen: boolean
}) {
  const [asking, setAsking] = useState<string | null>(null)
  const rep = rows.get(task.representative)
  const name = taskName(task, rows)
  if (!rep || !name) return null
  const finished = task.attention === 'done' && !rep.archived
  // Held only while that run still shows its actions: an unarchived run
  // leaves the list before it can say it is done.
  const shows = (id: string) =>
    id === rep.id ? !finished : rows.get(id)?.archived === true
  const aside = asking !== null && shows(asking) ? asking : null
  const hear = (id: string, action: string | null) =>
    setAsking(action === null ? null : id)
  return (
    <TaskRow
      status={runState({ ...rep, kind: rep.diagnosis.kind })}
      name={name}
      href={runHref(rep.id)}
      id={rep.id}
      marks={<Marks task={task} rep={rep} />}
      stage={finished ? null : <StageNow pipeline={rep.pipeline} />}
      meta={<Meta task={task} rep={rep} now={now} />}
      summary={finished ? null : <Summary task={task} rep={rep} rows={rows} />}
      toggleLabel={LIST.showRuns(name)}
      defaultOpen={defaultOpen}
    >
      <StageTrack pipeline={rep.pipeline} />
      {finished ? null : (
        <NextStep
          rep={rep}
          name={name}
          act={act}
          hidden={aside !== null && aside !== rep.id}
          onAsking={(action) => hear(rep.id, action)}
        />
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

/** A task's name: its first run's, or the run that shows it. */
export function taskName(
  task: Task,
  rows: Map<string, RunRow>,
): string | undefined {
  return rows.get(task.id)?.name ?? rows.get(task.representative)?.name
}

/** Whether a person archived the run that shows the task. */
export function isArchivedTask(task: Task, rows: Map<string, RunRow>): boolean {
  return rows.get(task.representative)?.archived === true
}

export function Tasks({
  tasks,
  rows,
  now,
  empty,
  act,
  open = false,
}: {
  tasks: Task[]
  rows: Map<string, RunRow>
  now: string
  /** Said when there are no tasks; a section shown only with tasks has none. */
  empty?: string
  act: Act
  /** Whether each row starts open. */
  open?: boolean
}) {
  if (tasks.length === 0) return empty ? <EmptyState>{empty}</EmptyState> : null
  return (
    <TaskList>
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          rows={rows}
          now={now}
          act={act}
          defaultOpen={open}
        />
      ))}
    </TaskList>
  )
}
