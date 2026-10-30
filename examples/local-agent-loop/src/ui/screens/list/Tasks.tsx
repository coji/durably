import { useState } from 'react'

import type { Task } from '../../../engine/status'
import type { Act } from '../../components/ActionNotice'
import { EmptyState } from '../../components/EmptyState'
import { LiveProgress } from '../../components/LiveProgress'
import { RunActions } from '../../components/RunActions'
import { runHref } from '../../components/RunLink'
import { StageNow, StageTrack } from '../../components/StageTrack'
import { ArchivedMark, FakeMark } from '../../components/SupersededMark'
import { runState, TaskList, TaskMeta, TaskRow } from '../../components/TaskRow'
import { LIST } from '../../glossary'
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
  const failure = rep.diagnosis.failure
  return (
    <TaskRow
      status={runState({ ...rep, kind: rep.diagnosis.kind })}
      name={name}
      href={runHref(rep.id)}
      id={rep.id}
      marks={
        <>
          {rep.archived ? <ArchivedMark /> : null}
          {task.attention === 'done' && task.fake ? <FakeMark /> : null}
        </>
      }
      stage={finished ? null : <StageNow pipeline={rep.pipeline} />}
      meta={<Meta task={task} rep={rep} now={now} />}
      summary={
        running ? (
          <LiveProgress live={rep.live} inline />
        ) : finished ? null : (
          diagnosisText(rep.diagnosis, rep.uncertainCall)
        )
      }
      toggleLabel={LIST.showRuns(name)}
      defaultOpen={defaultOpen}
    >
      <StageTrack pipeline={rep.pipeline} />
      {finished ? null : (
        <>
          {failure ? (
            <p className="text-fg-2 text-sm">
              {LIST.retry}
              {retryLabel(failure.retryable)}
            </p>
          ) : null}
          {aside === null || aside === rep.id ? (
            <RunActions
              key={rep.id}
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
  empty: string
  act: Act
  /** Whether each row starts open. */
  open?: boolean
}) {
  if (tasks.length === 0) return <EmptyState>{empty}</EmptyState>
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
