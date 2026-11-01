/**
 * The page's routes, read from the location hash. The list and the summary
 * can be narrowed to one repository by its key, as `?repo=` after the path;
 * a run's page keeps the one its list had, for its links back.
 */
export type Route =
  | { page: 'runs'; repo?: string }
  | { page: 'run'; id: string; repo?: string }
  | { page: 'compare'; repo?: string }
  | { page: 'design' }

export function parseRoute(hash: string): Route {
  const at = hash.indexOf('?')
  const path = at < 0 ? hash : hash.slice(0, at)
  const repo =
    at < 0 ? null : new URLSearchParams(hash.slice(at + 1)).get('repo')
  const scope = repo ? { repo } : {}
  const run = /^#\/runs\/(.+)$/.exec(path)
  if (run?.[1]) return { page: 'run', id: decodeURIComponent(run[1]), ...scope }
  if (path === '#/compare') return { page: 'compare', ...scope }
  if (path === '#/design') return { page: 'design' }
  return { page: 'runs', ...scope }
}

export function routeKey(route: Route): string {
  return route.page === 'run' ? `run:${route.id}` : route.page
}

/** `path` narrowed to `repo` when given one. */
export function withRepo(path: string, repo?: string): string {
  return repo ? `${path}?repo=${encodeURIComponent(repo)}` : path
}

/** Where the list or the summary is, narrowed to `repo` when given one. */
export function pageHref(page: 'runs' | 'compare', repo?: string): string {
  return withRepo(page === 'runs' ? '#/' : '#/compare', repo)
}
