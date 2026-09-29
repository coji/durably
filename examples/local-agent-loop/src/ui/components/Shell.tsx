import type { ReactNode } from 'react'

import { REFRESH, SHELL } from '../glossary'
import type { Route } from '../route'
import type { PollState } from '../usePolled'
import { focusPageTitle } from './Layout'
import { clockFormat } from './Time'

/**
 * The refresh time is shown but never announced. Screen readers hear only a
 * change of state: an alert when refreshing starts failing, and a status
 * line once it works again.
 */
export function RefreshStatus({ polled }: { polled: PollState<unknown> }) {
  const at = polled.fetchedAt ? clockFormat.format(polled.fetchedAt) : null
  const failing = polled.error !== null
  return (
    <div className="text-fg-2 text-xs">
      {failing ? (
        <>
          <p role="alert" className="sr-only">
            {REFRESH.failedAlert}
          </p>
          <p>
            {REFRESH.failed}
            {at ? REFRESH.staleAt(at) : ''}
          </p>
          <p className="font-code">{polled.error}</p>
        </>
      ) : (
        <p className="tabular-nums">
          {at ? REFRESH.freshAt(at) : REFRESH.loading}
        </p>
      )}
      <p role="status" className="sr-only">
        {polled.recovered ? REFRESH.recovered : ''}
      </p>
    </div>
  )
}

function NavLink({
  href,
  current,
  children,
}: {
  href: string
  current: boolean
  children: ReactNode
}) {
  return (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`inline-flex min-h-8 items-center rounded-md px-2 text-sm ${current ? 'bg-sunken text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
    >
      {children}
    </a>
  )
}

/** The sticky header with the two screens, and the page below it. */
export function Shell({
  route,
  status,
  children,
}: {
  route: Route
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="min-h-screen">
      {/* The hash is the router, so the skip link moves focus itself. */}
      <button
        type="button"
        onClick={focusPageTitle}
        className="bg-raised text-fg sr-only z-(--z-toast) rounded-md px-3 py-2 text-sm shadow-(--shadow-pop) focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {SHELL.skipToContent}
      </button>
      <header className="border-line bg-canvas sticky top-0 z-(--z-sticky) border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
          <span className="text-sm font-semibold">{SHELL.product}</span>
          <nav aria-label={SHELL.nav} className="flex gap-1">
            <NavLink
              href="#/"
              current={route.page === 'runs' || route.page === 'run'}
            >
              {SHELL.runs}
            </NavLink>
            <NavLink href="#/compare" current={route.page === 'compare'}>
              {SHELL.compare}
            </NavLink>
          </nav>
          {status ? <div className="ml-auto">{status}</div> : null}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}
