import { type Kysely, sql } from 'kysely'
import type { Database } from './schema'
import type { Run } from './storage'
import { rowToRun } from './transformers'

/**
 * PostgreSQL claim implementation using FOR UPDATE SKIP LOCKED + advisory locks.
 *
 * This provides strong concurrency guarantees:
 * - SKIP LOCKED avoids blocking on rows being claimed by other workers
 * - Advisory locks serialize per-concurrency-key to prevent double-leasing
 * - READ COMMITTED gives each statement a fresh snapshot after the advisory lock
 */
export async function claimNextPostgres(
  db: Kysely<Database>,
  workerId: string,
  now: string,
  leaseExpiresAt: string,
  activeLeaseGuard: ReturnType<typeof sql<boolean>>,
): Promise<Run | null> {
  return await db.transaction().execute(async (trx) => {
    const skipKeys: string[] = []

    for (;;) {
      const concurrencyCondition =
        skipKeys.length > 0
          ? sql`
              AND (
                concurrency_key IS NULL
                OR concurrency_key NOT IN (${sql.join(skipKeys)})
              )
            `
          : sql``

      const candidateResult = await sql<{
        id: string
        concurrency_key: string | null
      }>`
        SELECT id, concurrency_key
        FROM durably_runs
        WHERE
          (
            status = 'pending'
            OR (status = 'waiting' AND EXISTS (SELECT 1 FROM durably_waits w WHERE w.id = durably_runs.waiting_on_wait_id AND w.status = 'resolved'))
            OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ${now})
          )
          AND ${activeLeaseGuard}
          ${concurrencyCondition}
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `.execute(trx)

      const candidate = candidateResult.rows[0]
      if (!candidate) return null

      if (candidate.concurrency_key) {
        const lockAcquired = await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtext(${candidate.concurrency_key})) AS acquired
        `.execute(trx)

        if (!lockAcquired.rows[0]?.acquired) {
          skipKeys.push(candidate.concurrency_key)
          continue
        }

        const conflict = await sql`
          SELECT 1 FROM durably_runs
          WHERE concurrency_key = ${candidate.concurrency_key}
            AND id <> ${candidate.id}
            AND status = 'leased'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > ${now}
          LIMIT 1
        `.execute(trx)

        if (conflict.rows.length > 0) {
          skipKeys.push(candidate.concurrency_key)
          continue
        }
      }

      const result = await sql<Database['durably_runs']>`
        UPDATE durably_runs
        SET
          status = 'leased',
          lease_owner = ${workerId},
          lease_expires_at = ${leaseExpiresAt},
          lease_generation = lease_generation + 1,
          started_at = COALESCE(started_at, ${now}),
          updated_at = ${now}
        WHERE id = ${candidate.id}
        RETURNING *
      `.execute(trx)

      const row = result.rows[0]
      if (!row) return null
      if (row.waiting_on_wait_id) {
        await trx
          .updateTable('durably_waits')
          .set({ first_resumed_at: now })
          .where('id', '=', row.waiting_on_wait_id)
          .where('status', '=', 'resolved')
          .where('first_resumed_at', 'is', null)
          .execute()
      }
      return rowToRun(row)
    }
  })
}
