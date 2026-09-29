import { formatShortId } from '../../engine/format'

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
