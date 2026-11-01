/**
 * The page's routes, read from the location hash. The list and the summary
 * can be narrowed to one repository by its key, as `?repo=` after the path.
 */
export type Route =
  | { page: 'runs'; repo?: string }
  | { page: 'run'; id: string }
  | { page: 'compare'; repo?: string }
  | { page: 'design' }

export function parseRoute(hash: string): Route {
  const at = hash.indexOf('?')
  const path = at < 0 ? hash : hash.slice(0, at)
  const repo =
    at < 0 ? null : new URLSearchParams(hash.slice(at + 1)).get('repo')
  const scope = repo ? { repo } : {}
  const run = /^#\/runs\/(.+)$/.exec(path)
  if (run?.[1]) return { page: 'run', id: decodeURIComponent(run[1]) }
  if (path === '#/compare') return { page: 'compare', ...scope }
  if (path === '#/design') return { page: 'design' }
  return { page: 'runs', ...scope }
}

export function routeKey(route: Route): string {
  return route.page === 'run' ? `run:${route.id}` : route.page
}

/** Where the list or the summary is, narrowed to `repo` when given one. */
export function pageHref(page: 'runs' | 'compare', repo?: string): string {
  const path = page === 'runs' ? '#/' : '#/compare'
  return repo ? `${path}?repo=${encodeURIComponent(repo)}` : path
}
