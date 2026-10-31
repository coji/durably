import { useState } from 'react'

import { formatCount } from '../../../engine/format'
import type { Task } from '../../../engine/status'
import type { Act } from '../../components/ActionNotice'
import type { BulkAct } from '../../components/BulkNotice'
import { BUTTON } from '../../components/button'
import { Section } from '../../components/Layout'
import { BULK, LIST } from '../../glossary'
import type { RunRow } from '../../server'
import { BulkBar } from './BulkBar'
import { SECTION_ID } from './Overview'
import { taskName, Tasks, type Selection } from './Tasks'

/** How many stopped tasks the list shows before the rest is asked for. */
export const STOP_PAGE = 5

/**
 * The section's checkbox: on when every task is chosen, mixed when some
 * are. It chooses every stopped task, also those not shown yet; the bar
 * says how many.
 */
function SelectAll({
  chosen,
  total,
  onChange,
}: {
  chosen: number
  total: number
  onChange: (on: boolean) => void
}) {
  return (
    <label className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={chosen === total}
        ref={(el) => {
          if (el) el.indeterminate = chosen > 0 && chosen < total
        }}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-fg size-4 cursor-pointer"
      />
      {BULK.selectAll}
    </label>
  )
}

/**
 * Stopped tasks, newest first as the engine gave them. Only the newest few
 * show, so old stops do not push the finished list off the screen; the
 * section's count still says how many there are. With `actMany`, tasks can
 * be chosen and archived together; a chosen task that leaves the section,
 * such as one retried, leaves the choice with it.
 */
export function StopTasks({
  tasks,
  rows,
  now,
  act,
  actMany,
}: {
  tasks: Task[]
  rows: Map<string, RunRow>
  now: string
  act: Act
  actMany?: BulkAct
}) {
  const [all, setAll] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const shown = all ? tasks : tasks.slice(0, STOP_PAGE)
  const rest = tasks.length - shown.length
  const chosen = tasks.filter((t) => picked.has(t.id))
  const selection: Selection = {
    has: (id) => picked.has(id),
    set: (id, on) =>
      setPicked((now) => {
        const next = new Set(now)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
  }
  const items = chosen.map((t) => ({
    runId: t.id,
    name: taskName(t, rows) ?? t.id,
  }))
  return (
    <Section
      id={SECTION_ID.stop}
      title={LIST.stopped}
      count={tasks.length}
      tools={
        actMany ? (
          <SelectAll
            chosen={chosen.length}
            total={tasks.length}
            onChange={(on) =>
              setPicked(on ? new Set(tasks.map((t) => t.id)) : new Set())
            }
          />
        ) : null
      }
    >
      <Tasks
        tasks={shown}
        rows={rows}
        now={now}
        act={act}
        selection={actMany ? selection : undefined}
      />
      {rest > 0 ? (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className={BUTTON} onClick={() => setAll(true)}>
            {LIST.showMore(formatCount(rest))}
          </button>
        </div>
      ) : null}
      {actMany && items.length > 0 ? (
        <BulkBar
          items={items}
          onArchive={async () => {
            await actMany({ action: 'archive-series', items })
            setPicked(new Set())
          }}
          onClear={() => setPicked(new Set())}
        />
      ) : null}
    </Section>
  )
}
