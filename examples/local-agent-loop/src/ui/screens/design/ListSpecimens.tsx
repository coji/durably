import { useState } from 'react'

import { DESIGN, LIST } from '../../glossary'
import { DoneFilters } from '../list/DoneTasks'
import { Overview } from '../list/Overview'
import { State } from './Specimen'

/** The list's counts with tasks in every place, and with none waiting. */
export function OverviewStates() {
  return (
    <>
      <State label={DESIGN.state.attention}>
        <Overview
          counts={{ decision: 2, active: 1, running: 1, stop: 3, done: 41 }}
        />
      </State>
      <State label={DESIGN.state.calm}>
        <Overview
          counts={{ decision: 0, active: 1, running: 0, stop: 0, done: 41 }}
          note={LIST.attentionEmpty}
        />
      </State>
    </>
  )
}

/** The finished list's filter and archived switch, working on their own. */
export function FilterStates() {
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <DoneFilters
        query={query}
        onQuery={setQuery}
        archived={archived}
        onArchived={setArchived}
        archivedCount={12}
      />
    </div>
  )
}
