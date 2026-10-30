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
          counts={[
            { key: 'decision', label: LIST.decision, n: 2, tone: 'waiting' },
            { key: 'active', label: LIST.active, n: 1, tone: 'running' },
            { key: 'stop', label: LIST.stopped, n: 3, tone: 'failed' },
            { key: 'done', label: LIST.overviewDone, n: 41, tone: 'done' },
          ]}
        />
      </State>
      <State label={DESIGN.state.calm}>
        <Overview
          counts={[
            { key: 'decision', label: LIST.decision, n: 0, tone: 'waiting' },
            { key: 'active', label: LIST.active, n: 0, tone: 'running' },
            { key: 'stop', label: LIST.stopped, n: 0, tone: 'failed' },
            { key: 'done', label: LIST.overviewDone, n: 41, tone: 'done' },
          ]}
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
