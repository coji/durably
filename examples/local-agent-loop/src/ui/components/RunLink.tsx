import { formatShortId } from '../../engine/format'
import { RELATION_NAME } from '../glossary'
import type { Relations } from '../server'

/** The last characters of a run ID: enough to tell runs apart at a glance. */
export function IdSuffix({ id }: { id: string }) {
  return (
    <span className="font-code text-fg-2 text-xs">{formatShortId(id)}</span>
  )
}

/** A run by its name, with the ID suffix as a quiet aside. */
export function RunLink({ id, name }: { id: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2">
      <a
        href={`#/runs/${encodeURIComponent(id)}`}
        className="text-fg decoration-line-strong min-w-0 truncate font-medium underline underline-offset-2 hover:decoration-current"
      >
        {name}
      </a>
      <IdSuffix id={id} />
    </span>
  )
}

/**
 * The run a repair run started from, and the repair runs started from this
 * one, each by its name. Nothing when the run has neither.
 */
export function RelationLinks({ relations }: { relations: Relations }) {
  const { parent, children } = relations
  if (!parent && children.length === 0) return null
  return (
    <dl className="flex flex-col gap-1 text-xs">
      {parent ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="text-fg-2">{RELATION_NAME.parent}</dt>
          <dd className="min-w-0">
            <RunLink id={parent.id} name={parent.name} />
          </dd>
        </div>
      ) : null}
      {children.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="text-fg-2">{RELATION_NAME.children}</dt>
          <dd className="flex min-w-0 flex-col gap-1">
            {children.map((c) => (
              <RunLink key={c.id} id={c.id} name={c.name} />
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}
