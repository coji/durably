import { useEffect, type ReactNode } from 'react'

import { EmptyState } from '../components/EmptyState'
import { PageTitle } from '../components/Layout'
import { RepoContext } from '../components/RunLink'
import { RefreshStatus, Shell } from '../components/Shell'
import { REFRESH, SHELL } from '../glossary'
import { pageHref, reconciledHref, type Route } from '../route'
import { usePolled } from '../usePolled'

/**
 * One polled page under its h1. The h1 stays the same element from loading
 * to loaded, so focus moved to it on a route change is not lost.
 */
export function PolledPage<T>({
  route,
  repo,
  url,
  heading,
  back,
  notice,
  counted,
  render,
}: {
  route: Route
  /** The repository last chosen, which the links to the list keep. */
  repo?: string
  url: string
  heading: (data: T | null) => ReactNode
  back?: boolean
  /** What the last action came to; the next refresh shows its effect. */
  notice?: ReactNode
  /**
   * The repository the server counted for a list or the summary, which the
   * URL is set to, in place, when it says another.
   */
  counted?: (data: T) => string | null
  render: (data: T) => ReactNode
}) {
  const polled = usePolled<T>(url)
  const fix =
    polled.data && counted ? reconciledHref(route, counted(polled.data)) : null
  // `replace` moves the hash without a history entry, and is heard as a
  // route change, unlike `history.replaceState`.
  useEffect(() => {
    if (fix !== null) location.replace(fix)
  }, [fix])
  return (
    <RepoContext value={repo}>
      <Shell
        route={route}
        repo={repo}
        status={<RefreshStatus polled={polled} />}
      >
        <div className="mb-6 flex flex-col gap-2">
          {back ? (
            <a
              href={pageHref('runs', repo)}
              className="text-fg-2 hover:text-fg inline-flex min-h-8 items-center self-start text-sm"
            >
              {SHELL.back}
            </a>
          ) : null}
          <PageTitle>{heading(polled.data)}</PageTitle>
        </div>
        {notice ? <div className="mb-6">{notice}</div> : null}
        {polled.data ? (
          render(polled.data)
        ) : polled.error ? (
          <EmptyState kind="error">
            {REFRESH.loadFailed(polled.error)}
          </EmptyState>
        ) : (
          <EmptyState kind="loading">{REFRESH.loading}</EmptyState>
        )}
      </Shell>
    </RepoContext>
  )
}
