import type { ReactNode } from 'react'

import { PageTitle } from '../components/Layout'
import { Shell } from '../components/Shell'
import { DESIGN } from '../glossary'
import type { Route } from '../route'
import {
  ActionStates,
  BadgeStates,
  CopyStates,
  EmptyStates,
  FindingStates,
  LinkStates,
  LiveStates,
  NoticeStates,
  PathStates,
} from './design/BasicSpecimens'
import {
  CollapsibleStates,
  KeyValueStates,
  MetricStates,
  StageTrackStates,
  TableStates,
  TaskRowStates,
  TraceStates,
} from './design/DataSpecimens'
import { HighlightStates } from './design/ReviewSpecimens'
import { Specimen } from './design/Specimen'

const PARTS: [keyof typeof DESIGN.part, () => ReactNode][] = [
  ['badge', BadgeStates],
  ['taskRow', TaskRowStates],
  ['links', LinkStates],
  ['stageTrack', StageTrackStates],
  ['live', LiveStates],
  ['metric', MetricStates],
  ['keyValue', KeyValueStates],
  ['findings', FindingStates],
  ['highlights', HighlightStates],
  ['table', TableStates],
  ['collapsible', CollapsibleStates],
  ['action', ActionStates],
  ['copy', CopyStates],
  ['empty', EmptyStates],
  ['notice', NoticeStates],
  ['path', PathStates],
  ['trace', TraceStates],
]

/** Parts wider than half the page: they get the full width per scheme. */
const WIDE = new Set<keyof typeof DESIGN.part>(['table', 'trace'])

/**
 * Every component in each of its states, in light and dark side by side,
 * drawn from static fixtures. It reads nothing from the API and starts no
 * polling; its actions stop at the confirmation and write nothing.
 */
export function DesignScreen({ route }: { route: Route }) {
  return (
    <Shell route={route}>
      <div className="mb-6 flex flex-col gap-2">
        <PageTitle>{DESIGN.title}</PageTitle>
        <p className="text-fg-2 text-sm">{DESIGN.intro}</p>
      </div>
      <nav aria-label={DESIGN.contents} className="mb-8">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {PARTS.map(([key]) => (
            <li key={key}>
              <a
                href={`#design-${key}`}
                onClick={(e) => {
                  // The hash is the router; scroll without leaving the page.
                  e.preventDefault()
                  document.getElementById(`design-${key}`)?.scrollIntoView()
                }}
                className="text-fg-2 hover:text-fg underline underline-offset-2"
              >
                {DESIGN.part[key].name}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-12">
        {PARTS.map(([key, States]) => (
          <Specimen
            key={key}
            id={`design-${key}`}
            name={DESIGN.part[key].name}
            about={DESIGN.part[key].about}
            wide={WIDE.has(key)}
          >
            <States />
          </Specimen>
        ))}
      </div>
    </Shell>
  )
}
