import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/_index.tsx'),
  route('api/durably/*', 'routes/api.durably.$.ts'),
  route('api/worker', 'routes/api.worker.ts'),
] satisfies RouteConfig
