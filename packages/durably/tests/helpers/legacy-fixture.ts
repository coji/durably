import { type Kysely, sql } from 'kysely'

import type { Database } from '../../src/schema'

/** Seed old schema using SQL, without calling the current version's store. */
export async function seedLegacyRun(db: Kysely<Database>) {
  const id = 'legacy-run'
  const now = new Date().toISOString()
  await sql`INSERT INTO durably_runs
    (id, job_name, input, status, lease_owner, lease_generation, lease_expires_at,
     current_step_index, completed_step_count, created_at, updated_at)
    VALUES (${id}, 'legacy', '{"value":1}', 'leased', 'old-worker', 1,
      ${new Date(Date.now() + 30_000).toISOString()}, 1, 1, ${now}, ${now})`.execute(
    db,
  )
  await sql`INSERT INTO durably_steps
    (id, run_id, name, "index", status, output, started_at, completed_at)
    VALUES ('legacy-step', ${id}, 'old-step', 0, 'completed', '42', ${now}, ${now})`.execute(
    db,
  )
  return { id }
}
