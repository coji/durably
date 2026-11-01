import { createContext, useContext } from 'react'

import { formatShortId } from '../../engine/format'
import { withRepo } from '../route'

/** Where a run's detail page is, keeping the repository `repo` if given. */
export const runHref = (id: string, repo?: string) =>
  withRepo(`#/runs/${encodeURIComponent(id)}`, repo)

/**
 * The repository the page is narrowed to, so a run opened from it in a new
 * tab keeps the choice for its links back.
 */
export const RepoContext = createContext<string | undefined>(undefined)

/** `runHref` with the page's repository. */
export function useRunHref(): (id: string) => string {
  const repo = useContext(RepoContext)
  return (id) => runHref(id, repo)
}

/** The last characters of a run ID: enough to tell runs apart at a glance. */
export function IdSuffix({ id }: { id: string }) {
  return (
    <span className="font-code text-fg-2 text-xs">{formatShortId(id)}</span>
  )
}

/** A run by its name, with the ID suffix as a quiet aside. */
export function RunLink({ id, name }: { id: string; name: string }) {
  const href = useRunHref()
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2">
      <a
        href={href(id)}
        className="text-fg decoration-line-strong min-w-0 truncate font-medium underline underline-offset-2 hover:decoration-current"
      >
        {name}
      </a>
      <IdSuffix id={id} />
    </span>
  )
}
