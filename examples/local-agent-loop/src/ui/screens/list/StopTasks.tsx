import { useState } from 'react'

import { formatCount } from '../../../engine/format'
import type { Task } from '../../../engine/status'
import type { Act } from '../../components/ActionNotice'
import { BUTTON } from '../../components/button'
import { Section } from '../../components/Layout'
import { LIST } from '../../glossary'
import type { RunRow } from '../../server'
import { SECTION_ID } from './Overview'
import { Tasks } from './Tasks'

/** How many stopped tasks the list shows before the rest is asked for. */
export const STOP_PAGE = 5

/**
 * Stopped tasks, newest first as the engine gave them. Only the newest few
 * show, so old stops do not push the finished list off the screen; the
 * section's count still says how many there are.
 */
export function StopTasks({
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
  const [all, setAll] = useState(false)
  const shown = all ? tasks : tasks.slice(0, STOP_PAGE)
  const rest = tasks.length - shown.length
  return (
    <Section id={SECTION_ID.stop} title={LIST.stopped} count={tasks.length}>
      <Tasks tasks={shown} rows={rows} now={now} act={act} />
      {rest > 0 ? (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className={BUTTON} onClick={() => setAll(true)}>
            {LIST.showMore(formatCount(rest))}
          </button>
        </div>
      ) : null}
    </Section>
  )
}
