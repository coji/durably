import { COMMON, LIST } from '../glossary'
import type { LineageRun } from '../server'
import { runHref } from './RunLink'
import { StatusBadge } from './StatusBadge'
import { ArchivedMark, SupersededMark } from './SupersededMark'
import { runRole, runState } from './TaskRow'
import { Ago } from './Time'

/**
 * Every run of the task this page's run belongs to, by its place in the
 * task as the list names it, each with its state and when it started. The
 * run on this page is marked, not linked. Nothing for a task of one run.
 */
export function TaskLineage({
  runs,
  current,
  now,
}: {
  runs: LineageRun[]
  /** The ID of the run this page shows. */
  current: string
  now: string
}) {
  if (runs.length <= 1) return null
  return (
    <nav aria-label={LIST.lineage} className="flex flex-col gap-1 text-xs">
      <h2 className="text-fg-2 font-normal">{LIST.lineage}</h2>
      <ol className="flex flex-wrap gap-x-5 gap-y-2">
        {runs.map((r) => {
          const state = runState(r)
          const here = r.id === current
          return (
            <li key={r.id} className="inline-flex items-center gap-2">
              <StatusBadge label={state.label} tone={state.tone} />
              {here ? (
                <span aria-current="page" className="text-fg font-medium">
                  {runRole(r)}
                  <span className="text-fg-2 font-normal">
                    {COMMON.separator}
                    {LIST.current}
                  </span>
                </span>
              ) : (
                <a
                  href={runHref(r.id)}
                  className="text-fg decoration-line-strong underline underline-offset-2 hover:decoration-current"
                >
                  {runRole(r)}
                </a>
              )}
              {r.superseded ? <SupersededMark /> : null}
              {r.archived ? <ArchivedMark /> : null}
              <span className="text-fg-2">
                <Ago iso={r.createdAt} now={now} />
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
