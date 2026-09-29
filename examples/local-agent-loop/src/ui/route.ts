/** The page's routes, read from the location hash. */
export type Route =
  | { page: 'runs' }
  | { page: 'run'; id: string }
  | { page: 'compare' }
  | { page: 'design' }

export function parseRoute(hash: string): Route {
  const run = /^#\/runs\/(.+)$/.exec(hash)
  if (run?.[1]) return { page: 'run', id: decodeURIComponent(run[1]) }
  if (hash === '#/compare') return { page: 'compare' }
  if (hash === '#/design') return { page: 'design' }
  return { page: 'runs' }
}

export function routeKey(route: Route): string {
  return route.page === 'run' ? `run:${route.id}` : route.page
}
