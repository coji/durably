/**
 * The factory's web UI: tasks that wait on a person or stopped first, then
 * open ones, then finished ones; one run's report; the finished runs by week
 * or by config version; and the design page of every component. Every value
 * is shown as the API returns it from `diagnose`, `groupTasks`,
 * `buildReport`, `trendOf` and `compareReports`; nothing is recomputed here.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { focusPageTitle } from './components/Layout'
import { SHELL } from './glossary'
import { parseRoute, routeKey, type Route } from './route'
import {
  CompareScreen,
  TrendScreen,
  type CompareView,
} from './screens/CompareScreen'
import { DesignScreen } from './screens/DesignScreen'
import { PolledPage } from './screens/PolledPage'
import { RunScreen } from './screens/RunScreen'
import { RunsScreen } from './screens/RunsScreen'
import type {
  CompareResponse,
  RunDetailResponse,
  RunsResponse,
  TrendResponse,
} from './server'

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useRoute(): Route {
  return parseRoute(
    useSyncExternalStore(subscribeHash, () => window.location.hash),
  )
}

/**
 * After `key` changes (not on the first load), focus the new page's h1: a
 * new route, or the summary switched to its other view, whose page replaces
 * the button that was pressed.
 */
function useFocusOnChange(key: string) {
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (previous.current !== null && previous.current !== key) focusPageTitle()
    previous.current = key
  }, [key])
}

export function App() {
  const route = useRoute()
  useFocusOnChange(routeKey(route))
  // The summary opens on the weekly trend when the page loads; the config
  // view is a second reading of the same runs, one press away. The choice
  // lives here, above the routes, so going to another page and back keeps
  // the view last chosen until the page reloads.
  const [compareView, setCompareView] = useState<CompareView>('trend')
  useFocusOnChange(compareView)
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
    return compareView === 'trend' ? (
      <PolledPage<TrendResponse>
        key="trend"
        route={route}
        url="/api/trend"
        heading={() => SHELL.compare}
        render={(data) => <TrendScreen data={data} onView={setCompareView} />}
      />
    ) : (
      <PolledPage<CompareResponse>
        key="compare"
        route={route}
        url="/api/compare"
        heading={() => SHELL.compare}
        render={(data) => <CompareScreen data={data} onView={setCompareView} />}
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
