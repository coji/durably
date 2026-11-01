import { REPO } from '../glossary'
import { pageHref } from '../route'
import type { RepoScope } from '../server'

/**
 * Which repository the page counts, as links, so the choice lives in the
 * URL: all of them, or one. The current one is the one the server says it
 * counted, so a key no run has any more reads as all. Not drawn while the
 * runs have only one repository, since there is nothing to choose.
 */
export function RepoFilter({
  page,
  scope,
}: {
  page: 'runs' | 'compare'
  scope: RepoScope
}) {
  if (scope.repos.length < 2) return null
  // A repository's path shows on hover; the sample and all have none.
  const option = (key: string | null, label: string) => (
    <li key={key ?? ''}>
      <a
        href={pageHref(page, key ?? undefined)}
        title={key?.startsWith('/') ? key : undefined}
        aria-current={scope.repo === key ? 'true' : undefined}
        className={`inline-flex min-h-8 items-center rounded-sm px-3 text-sm ${scope.repo === key ? 'bg-raised text-fg border-line-strong border font-medium' : 'text-fg-2 hover:text-fg border border-transparent'}`}
      >
        {label}
      </a>
    </li>
  )
  return (
    <nav aria-label={REPO.label} className="mb-4 flex flex-col gap-1">
      <span className="text-fg-2 text-xs">{REPO.label}</span>
      <ul className="bg-sunken inline-flex flex-wrap self-start rounded-md p-1">
        {option(null, REPO.all)}
        {scope.repos.map((r) => option(r.key, r.name))}
      </ul>
    </nav>
  )
}
