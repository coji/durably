/**
 * Background Worker Endpoint
 *
 * Called by Vercel Cron to process pending jobs when no users are connected.
 * Authenticated via CRON_SECRET to prevent unauthorized access.
 *
 * Vercel Cron sends GET requests with CRON_SECRET as a Bearer token.
 * See: https://vercel.com/docs/cron-jobs
 *
 * GET /api/worker
 */

import { durably } from '~/lib/durably.server'
import type { Route } from './+types/api.worker'

export async function loader({ request }: Route.LoaderArgs) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Initialize (migrate + start worker) if needed
  await durably.init()

  // Process all pending jobs in this invocation
  const processed = await durably.processUntilIdle()

  return Response.json({ processed })
}
