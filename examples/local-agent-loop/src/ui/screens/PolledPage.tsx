import type { ReactNode } from 'react'

import { EmptyState } from '../components/EmptyState'
import { PageTitle } from '../components/Layout'
import { RefreshStatus, Shell } from '../components/Shell'
import { REFRESH, SHELL } from '../glossary'
import type { Route } from '../route'
import { usePolled } from '../usePolled'

/**
 * One polled page under its h1. The h1 stays the same element from loading
 * to loaded, so focus moved to it on a route change is not lost.
 */
export function PolledPage<T>({
  route,
  url,
  heading,
  back,
  notice,
  render,
}: {
  route: Route
  url: string
  heading: (data: T | null) => ReactNode
  back?: boolean
  /** What the last action came to; the next refresh shows its effect. */
  notice?: ReactNode
  render: (data: T) => ReactNode
}) {
  const polled = usePolled<T>(url)
  return (
    <Shell route={route} status={<RefreshStatus polled={polled} />}>
      <div className="mb-6 flex flex-col gap-2">
        {back ? (
          <a
            href="#/"
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
        <EmptyState kind="error">{REFRESH.loadFailed(polled.error)}</EmptyState>
      ) : (
        <EmptyState kind="loading">{REFRESH.loading}</EmptyState>
      )}
    </Shell>
  )
}
