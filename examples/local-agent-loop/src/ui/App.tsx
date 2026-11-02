/**
 * The factory's web UI: tasks that wait on a person or stopped first, then
 * open ones, then finished ones; one run's report; the finished runs by week
 * or by config version; and the design page of every component. Every value
 * is shown as the API returns it from `diagnose`, `groupTasks`,
 * `buildReport`, `trendOf` and `compareReports`; nothing is recomputed here.
 * Actions go to the server, which calls the CLI's functions; the page shows
 * what came of each as a notice and the next refresh shows the run moved.
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import {
  ActionNotice,
  type Act,
  type ActionResult,
} from './components/ActionNotice'
import {
  BulkNotice,
  BulkProgress,
  sendEach,
  seriesOutcome,
  type BulkAct,
  type BulkItem,
  type ItemAnswer,
  type BulkRequest,
  type SeriesResult,
} from './components/BulkNotice'
import { focusPageTitle } from './components/Layout'
import { runHref } from './components/RunLink'
import { SHELL } from './glossary'
import {
  noticesOn,
  withNotice,
  withoutNotice,
  type NoticeEntry,
  type NoticeOutcome,
} from './notices'
import { parseRoute, routeKey, withRepo, type Route } from './route'
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

/** The header `server.ts` reads the page's token from. */
const TOKEN_HEADER = 'x-loop-ui-token'

/** One POST to an action's path; the server's answer, or its refusal. */
async function post(
  token: string,
  runId: string,
  action: string,
  body: unknown,
): Promise<ActionResult & SeriesResult> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body ?? {}),
  })
  const answer = (await res.json()) as ActionResult &
    SeriesResult & { error?: string }
  if (!res.ok) throw new Error(answer.error ?? `HTTP ${res.status}`)
  return answer
}

/**
 * One item of a bulk action, as `seriesOutcome` reads its answer, or why
 * the request failed. A task's `archive-series` that could not archive
 * every stop counts as failed, with the CLI's own reasons, and keeps the
 * runs it did archive.
 */
async function postItem(
  token: string,
  action: BulkRequest['action'],
  item: BulkItem,
): Promise<ItemAnswer> {
  try {
    return seriesOutcome(await post(token, item.runId, action, {}))
  } catch (error) {
    return { archived: [], warnings: [], error: (error as Error).message }
  }
}

/**
 * Send actions with the page's token, one POST each, and keep what each
 * came to until it is closed or the page changes (`withNotice`). A bulk
 * action sends its items one after another, as the CLI does them, and its
 * own notice shows how many have their answer until the last one does.
 */
function useActions(token: string, page: string) {
  const [entries, setEntries] = useState<NoticeEntry[]>([])
  const lastId = useRef(0)
  const show = useCallback(
    (id: number, outcome: NoticeOutcome) =>
      setEntries((now) => withNotice(now, { id, page, outcome })),
    [page],
  )
  const close = useCallback(
    (id: number) => setEntries((now) => withoutNotice(now, id)),
    [],
  )
  const act = useCallback<Act>(
    async (request) => {
      const id = ++lastId.current
      try {
        const result = await post(
          token,
          request.runId,
          request.action,
          request.body,
        )
        show(id, { kind: 'one', outcome: { request, result } })
        return true
      } catch (error) {
        show(id, {
          kind: 'one',
          outcome: { request, error: (error as Error).message },
        })
        return false
      }
    },
    [token, show],
  )
  // `id` is the notice it shows in: a new one, or the one whose undo it is.
  const send = useCallback(
    async (request: BulkRequest, id: number) => {
      const total = request.items.length
      const progress = (done: number) =>
        show(id, { kind: 'progress', action: request.action, done, total })
      progress(0)
      const outcome = await sendEach(
        request,
        (item) => postItem(token, request.action, item),
        progress,
      )
      show(id, { kind: 'bulk', outcome })
    },
    [token, show],
  )
  const actMany = useCallback<BulkAct>(
    (request) => send(request, ++lastId.current),
    [send],
  )
  const shown = noticesOn(entries, page).map(({ id, outcome }) => (
    <Fragment key={id}>
      {outcome.kind === 'one' ? (
        <ActionNotice outcome={outcome.outcome} onDismiss={() => close(id)} />
      ) : outcome.kind === 'progress' ? (
        <BulkProgress
          action={outcome.action}
          done={outcome.done}
          total={outcome.total}
        />
      ) : (
        <BulkNotice
          outcome={outcome.outcome}
          onUndo={(request) => void send(request, id)}
          onDismiss={() => close(id)}
        />
      )}
    </Fragment>
  ))
  const notice =
    shown.length > 0 ? <div className="flex flex-col gap-3">{shown}</div> : null
  return { act, actMany, notice }
}

export function App({ token }: { token: string }) {
  const route = useRoute()
  useFocusOnChange(routeKey(route))
  const { act, actMany, notice } = useActions(token, routeKey(route))
  // The summary opens on the weekly trend when the page loads; the config
  // view is a second reading of the same runs, one press away. The choice
  // lives here, above the routes, so going to another page and back keeps
  // the view last chosen until the page reloads.
  const [compareView, setCompareView] = useState<CompareView>('trend')
  useFocusOnChange(compareView)
  // The repository the list or the summary was last narrowed to, from its
  // URL: a run's page keeps it for its links back, and writes it into its
  // own URL so a reload keeps it too.
  const [lastRepo, setLastRepo] = useState<string | undefined>(undefined)
  const repo =
    route.page === 'runs' || route.page === 'compare'
      ? route.repo
      : route.page === 'run'
        ? (route.repo ?? lastRepo)
        : lastRepo
  if (repo !== lastRepo) setLastRepo(repo)
  const runId = route.page === 'run' ? route.id : null
  const runRepo = route.page === 'run' ? route.repo : undefined
  useEffect(() => {
    if (runId !== null && repo && runRepo !== repo)
      history.replaceState(null, '', withRepo(runHref(runId), repo))
  }, [runId, runRepo, repo])
  const query = withRepo('', repo)
  // Switching repositories replaces the page, the pressed link with it.
  useFocusOnChange(query)
  // The design page reads nothing from the API, so nothing polls there.
  if (route.page === 'design') return <DesignScreen route={route} />
  // Keyed by URL, so moving to another page stops the old page's polling
  // and never shows one run's data under another's address, nor one
  // repository's list, and the tasks chosen in it, under another's.
  if (route.page === 'run') {
    const url = `/api/runs/${encodeURIComponent(route.id)}`
    return (
      <PolledPage<RunDetailResponse>
        key={url}
        route={route}
        repo={repo}
        url={url}
        back
        notice={notice}
        heading={(data) => data?.name ?? SHELL.runFallback}
        render={(data) => <RunScreen data={data} act={act} />}
      />
    )
  }
  if (route.page === 'compare')
    return compareView === 'trend' ? (
      <PolledPage<TrendResponse>
        key={`trend${query}`}
        route={route}
        repo={repo}
        url={`/api/trend${query}`}
        counted={(data) => data.repo}
        heading={() => SHELL.compare}
        render={(data) => <TrendScreen data={data} onView={setCompareView} />}
      />
    ) : (
      <PolledPage<CompareResponse>
        key={`compare${query}`}
        route={route}
        repo={repo}
        url={`/api/compare${query}`}
        counted={(data) => data.repo}
        heading={() => SHELL.compare}
        render={(data) => <CompareScreen data={data} onView={setCompareView} />}
      />
    )
  return (
    <PolledPage<RunsResponse>
      key={`runs${query}`}
      route={route}
      repo={repo}
      url={`/api/runs${query}`}
      counted={(data) => data.repo}
      notice={notice}
      heading={() => SHELL.runs}
      render={(data) => <RunsScreen data={data} act={act} actMany={actMany} />}
    />
  )
}
