/**
 * The factory's web UI: runs that need a person first, then open runs, then
 * finished ones; one run's report; the comparison of finished runs by config
 * version; and the design page of every component. Every value is shown as
 * the API returns it from `diagnose`, `buildReport` and `compareReports`;
 * nothing is recomputed here.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

import { focusPageTitle } from './components/Layout'
import { SHELL } from './glossary'
import { parseRoute, routeKey, type Route } from './route'
import { CompareScreen } from './screens/CompareScreen'
import { DesignScreen } from './screens/DesignScreen'
import { PolledPage } from './screens/PolledPage'
import { RunScreen } from './screens/RunScreen'
import { RunsScreen } from './screens/RunsScreen'
import type { CompareResponse, RunDetailResponse, RunsResponse } from './server'

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useRoute(): Route {
  return parseRoute(
    useSyncExternalStore(subscribeHash, () => window.location.hash),
  )
}

/** After a route change (not the first load), focus the new page's h1. */
function useFocusOnRouteChange(route: Route) {
  const key = routeKey(route)
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (previous.current !== null && previous.current !== key) focusPageTitle()
    previous.current = key
  }, [key])
}

export function App() {
  const route = useRoute()
  useFocusOnRouteChange(route)
  // The design page reads nothing from the API, so nothing polls there.
  if (route.page === 'design') return <DesignScreen route={route} />
  // Keyed by URL, so moving to another page stops the old page's polling
  // and never shows one run's data under another's address.
  if (route.page === 'run') {
    const url = `/api/runs/${encodeURIComponent(route.id)}`
    return (
      <PolledPage<RunDetailResponse>
        key={url}
        route={route}
        url={url}
        back
        heading={(data) => data?.name ?? SHELL.runFallback}
        render={(data) => <RunScreen data={data} />}
      />
    )
  }
  if (route.page === 'compare')
    return (
      <PolledPage<CompareResponse>
        key="compare"
        route={route}
        url="/api/compare"
        heading={() => SHELL.compare}
        render={(data) => <CompareScreen data={data} />}
      />
    )
  return (
    <PolledPage<RunsResponse>
      key="runs"
      route={route}
      url="/api/runs"
      heading={() => SHELL.runs}
      render={(data) => <RunsScreen data={data} />}
    />
  )
}
