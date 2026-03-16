import { type Kysely, sql } from 'kysely'
import type { Database } from './schema'
import type { Run } from './storage'
import { rowToRun } from './transformers'

/**
 * SQLite claim implementation using atomic UPDATE with subquery.
 *
 * Single-writer — relies on the process-level write mutex for safety.
 * The subquery finds the next eligible candidate and the UPDATE claims
 * it in a single atomic statement (no TOCTOU).
 */
export async function claimNextSqlite(
  db: Kysely<Database>,
  workerId: string,
  now: string,
  leaseExpiresAt: string,
  activeLeaseGuard: ReturnType<typeof sql<boolean>>,
): Promise<Run | null> {
  const subquery = db
    .selectFrom('durably_runs')
    .select('durably_runs.id')
    .where((eb) =>
      eb.or([
        eb('status', '=', 'pending'),
        eb.and([
          eb('status', '=', 'leased'),
          eb('lease_expires_at', 'is not', null),
          eb('lease_expires_at', '<=', now),
        ]),
      ]),
    )
    .where(activeLeaseGuard)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(1)

  const row = await db
    .updateTable('durably_runs')
    .set({
      status: 'leased',
      lease_owner: workerId,
      lease_expires_at: leaseExpiresAt,
      lease_generation: sql`lease_generation + 1`,
      started_at: sql`COALESCE(started_at, ${now})`,
      updated_at: now,
    })
    .where('id', '=', (eb) => eb.selectFrom(subquery.as('sub')).select('id'))
    .returningAll()
    .executeTakeFirst()

  if (!row) return null
  return rowToRun(row)
}
