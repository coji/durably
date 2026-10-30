import { formatCount } from '../../../engine/format'
import { TONE_FILL, type Tone } from '../../components/status'
import { LIST } from '../../glossary'

export const SECTION_ID = {
  decision: 'tasks-decision',
  active: 'tasks-active',
  stop: 'tasks-stop',
  done: 'tasks-done',
} as const

/**
 * How many tasks stand where, in the order the page shows them, each a
 * button to its part of the page. A count with nothing in it is quiet; the
 * three that ask for attention keep their state's color while they hold
 * any. `note` says what the counts mean when that needs words.
 */
export function Overview({
  counts,
  note,
}: {
  /** A line under the counts, such as that nothing needs a person. */
  note?: string
  counts: {
    key: keyof typeof SECTION_ID
    label: string
    n: number
    tone: Tone
  }[]
}) {
  return (
    <nav aria-label={LIST.overview} className="mb-6">
      <ul className="flex flex-wrap gap-2">
        {counts.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              disabled={c.n === 0}
              onClick={() =>
                document
                  .getElementById(SECTION_ID[c.key])
                  ?.scrollIntoView({ block: 'start' })
              }
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
