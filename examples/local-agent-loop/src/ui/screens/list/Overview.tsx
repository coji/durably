import { formatCount } from '../../../engine/format'
import { TONE_FILL, type Tone } from '../../components/status'
import { LIST } from '../../glossary'

/** Where the overview's entries scroll to. */
export const SECTION_ID = {
  decision: 'tasks-decision',
  active: 'tasks-active',
  stop: 'tasks-stop',
  done: 'tasks-done',
} as const

/** How many tasks stand where; `running` is how many active ones run now. */
export interface OverviewCounts {
  decision: number
  active: number
  running: number
  stop: number
  done: number
}

/** Scroll to a part of the page and move focus there, as a link would. */
function jump(id: string) {
  const el = document.getElementById(id)
  el?.scrollIntoView({ block: 'start' })
  el?.focus({ preventScroll: true })
}

/**
 * How many tasks stand where, in the order the page shows them, each a
 * button to its part of the page. A count with nothing in it is quiet. A
 * decision and a stop keep their state's color while they hold any; the
 * active count is blue, with the running dot, only while a run is running,
 * since a queued run alone is not moving. `note` says what the counts mean
 * when that needs words.
 */
export function Overview({
  counts,
  note,
}: {
  counts: OverviewCounts
  /** A line under the counts, such as that nothing needs a person. */
  note?: string
}) {
  const items: {
    key: keyof typeof SECTION_ID
    label: string
    n: number
    tone: Tone
  }[] = [
    {
      key: 'decision',
      label: LIST.decision,
      n: counts.decision,
      tone: 'waiting',
    },
    {
      key: 'active',
      label: LIST.active,
      n: counts.active,
      tone: counts.running > 0 ? 'running' : 'done',
    },
    { key: 'stop', label: LIST.stopped, n: counts.stop, tone: 'failed' },
    { key: 'done', label: LIST.overviewDone, n: counts.done, tone: 'done' },
  ]
  return (
    <nav aria-label={LIST.overview} className="mb-6">
      <ul className="flex flex-wrap gap-2">
        {items.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              disabled={c.n === 0}
              onClick={() => jump(SECTION_ID[c.key])}
              className={`inline-flex min-h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-(--duration-fast) ease-out disabled:cursor-default ${c.n === 0 ? TONE_FILL.done : `${TONE_FILL[c.tone]} hover:brightness-95`}`}
            >
              {c.tone === 'running' && c.n > 0 ? (
                <span
                  aria-hidden
                  className="dot-live size-2 rounded-full bg-current"
                />
              ) : null}
              {c.label}
              <span className="font-code font-semibold">
                {formatCount(c.n)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {note ? <p className="text-fg-2 mt-3 text-sm">{note}</p> : null}
    </nav>
  )
}
