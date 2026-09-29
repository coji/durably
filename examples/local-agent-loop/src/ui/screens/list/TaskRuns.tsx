import { formatCost, formatDuration } from '../../../engine/format'
import type { Task } from '../../../engine/status'
import type { Act, ActionName } from '../../components/ActionNotice'
import { RunActions } from '../../components/RunActions'
import { IdSuffix, runHref } from '../../components/RunLink'
import { StatusBadge } from '../../components/StatusBadge'
import { ArchivedMark, SupersededMark } from '../../components/SupersededMark'
import { runRole, runState } from '../../components/TaskRow'
import { Ago } from '../../components/Time'
import { COMMON } from '../../glossary'
import type { RunRow } from '../../server'

/**
 * Every run of a task, oldest first, each by its place in the task. An
 * archived run other than the one that shows the task offers its way back
 * beside it, quiet. `aside` names the run whose action asks or works, so
 * the others' actions step aside; `onAsking` hears which run that is.
 */
export function TaskRuns({
  task,
  rows,
  now,
  name,
  act,
  aside = null,
  onAsking,
}: {
  task: Task
  rows: Map<string, RunRow>
  now: string
  /** The task's name, which an action's notice repeats. */
  name: string
  act: Act
  aside?: string | null
  onAsking?: (runId: string, action: ActionName | null) => void
}) {
  return (
    <ol className="border-line flex flex-col border-t">
      {task.runs.map((r) => {
        const row = rows.get(r.id)
        if (!row) return null
        const state = runState({
          ...row,
          kind: r.kind,
          superseded: r.superseded,
          archived: r.archived,
        })
        const back =
          row.archived &&
          r.id !== task.representative &&
          (aside === null || aside === r.id)
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
                {runRole(r)}
              </a>
              <IdSuffix id={r.id} />
              {r.superseded ? <SupersededMark /> : null}
              {r.archived ? <ArchivedMark /> : null}
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
            {back ? (
              <div className="basis-full">
                <RunActions
                  run={{ ...row, name }}
                  act={act}
                  compact
                  onAsking={(action) => onAsking?.(r.id, action)}
                />
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
