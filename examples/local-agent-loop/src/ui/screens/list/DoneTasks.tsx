import { useId, useState } from 'react'

import { formatCount } from '../../../engine/format'
import type { Task } from '../../../engine/status'
import type { Act } from '../../components/ActionNotice'
import { BUTTON } from '../../components/button'
import { Section } from '../../components/Layout'
import { LIST } from '../../glossary'
import type { RunRow } from '../../server'
import { SECTION_ID } from './Overview'
import { isArchivedTask, taskName, Tasks } from './Tasks'

/**
 * The finished list's tools: a filter on the task's name, and a switch
 * that brings the archived tasks back, shown only when there are any.
 */
export function DoneFilters({
  query,
  onQuery,
  archived,
  onArchived,
  archivedCount,
}: {
  query: string
  onQuery: (query: string) => void
  archived: boolean
  onArchived: (archived: boolean) => void
  archivedCount: number
}) {
  const filterId = useId()
  return (
    <>
      <label htmlFor={filterId} className="sr-only">
        {LIST.filter}
      </label>
      <input
        id={filterId}
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={LIST.filter}
        className="border-line-strong bg-raised text-fg placeholder:text-fg-3 min-h-8 w-(--size-filter) max-w-full rounded-md border px-3 text-sm"
      />
      {archivedCount > 0 ? (
        <label className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => onArchived(e.target.checked)}
            className="accent-fg size-4"
          />
          {LIST.showArchived(formatCount(archivedCount))}
        </label>
      ) : null}
    </>
  )
}

/** How many finished tasks the list shows before さらに表示. */
const PAGE = 30

/**
 * Finished tasks, newest first as the engine gave them. Archived ones stay
 * hidden until asked for, a name filter narrows the rest, and the list
 * grows a page at a time. None of this changes a task or its numbers.
 */
export function DoneTasks({
  tasks,
  rows,
  now,
  act,
}: {
  tasks: Task[]
  rows: Map<string, RunRow>
  now: string
  act: Act
}) {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const isArchived = (t: Task) => isArchivedTask(t, rows)
  const archivedCount = tasks.filter(isArchived).length
  const q = query.trim().toLowerCase()
  const named = tasks.filter(
    (t) => q === '' || (taskName(t, rows) ?? '').toLowerCase().includes(q),
  )
  const matches = archived ? named : named.filter((t) => !isArchived(t))
  // Said when the list is empty only because archived tasks are hidden.
  const onlyArchived = matches.length === 0 && named.length > 0
  const shown = matches.slice(0, limit)
  const rest = matches.length - shown.length
  return (
    <Section
      id={SECTION_ID.done}
      title={LIST.done}
      count={tasks.length}
      note={
        matches.length === tasks.length
          ? undefined
          : LIST.shownOf(formatCount(matches.length), formatCount(tasks.length))
      }
      tools={
        tasks.length > 0 ? (
          <DoneFilters
            query={query}
            onQuery={(q) => {
              setQuery(q)
              setLimit(PAGE)
            }}
            archived={archived}
            onArchived={setArchived}
            archivedCount={archivedCount}
          />
        ) : null
      }
    >
      <Tasks
        tasks={shown}
        rows={rows}
        now={now}
        empty={
          onlyArchived
            ? LIST.onlyArchived
            : q
              ? LIST.filterEmpty(query.trim())
              : LIST.doneEmpty
        }
        act={act}
      />
      {rest > 0 ? (
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            className={BUTTON}
            onClick={() => setLimit((n) => n + PAGE)}
          >
            {LIST.showMore(formatCount(Math.min(rest, PAGE)))}
          </button>
          <span className="text-fg-2 text-xs tabular-nums">
            {LIST.shownOf(
              formatCount(shown.length),
              formatCount(matches.length),
            )}
          </span>
        </div>
      ) : null}
    </Section>
  )
}
