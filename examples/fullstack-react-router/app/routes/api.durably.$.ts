/**
 * Durably API Route (Splat)
 *
 * GET  /api/durably/subscribe?runId=xxx - SSE stream for single run
 * GET  /api/durably/runs/subscribe?jobName=xxx - SSE stream for run updates
 * GET  /api/durably/runs - List runs
 * GET  /api/durably/run?runId=xxx - Get single run
 * POST /api/durably/trigger - Trigger a job
 * POST /api/durably/retry?runId=xxx - Retry a failed run
 * POST /api/durably/cancel?runId=xxx - Cancel a run
 */

import { durablyHandler } from '~/lib/durably.server'
import type { Route } from './+types/api.durably.$'

export async function loader({ request }: Route.LoaderArgs) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function action({ request }: Route.ActionArgs) {
  return durablyHandler.handle(request, '/api/durably')
}
