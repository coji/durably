import { type Kysely, sql } from 'kysely'
import { monotonicFactory } from 'ulidx'
import type { Database } from './schema'

const ulid = monotonicFactory()

export type RunStatus =
  | 'pending'
  | 'leased'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Run data for creating a new run
 */
export interface CreateRunInput<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
}

/**
 * Run data returned from storage
 */
export interface Run<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  id: string
  jobName: string
  input: unknown
  status: RunStatus
  idempotencyKey: string | null
  concurrencyKey: string | null
  currentStepIndex: number
  stepCount: number
  progress: { current: number; total?: number; message?: string } | null
  output: unknown | null
  error: string | null
  labels: TLabels
  leaseOwner: string | null
  leaseExpiresAt: string | null
  leaseGeneration: number
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Run filter options
 */
export interface RunFilter<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  status?: RunStatus
  /** Filter by job name(s). Pass a string for one, or an array for multiple (OR). */
  jobName?: string | string[]
  /** Filter by labels (all specified labels must match) */
  labels?: { [K in keyof TLabels]?: TLabels[K] }
  /** Maximum number of runs to return */
  limit?: number
  /** Number of runs to skip (for pagination) */
  offset?: number
}

/**
 * Step data for persisting a step checkpoint
 */
export interface CreateStepInput {
  name: string
  index: number
  status: 'completed' | 'failed' | 'cancelled'
  output?: unknown
  error?: string
  startedAt: string // ISO8601 timestamp when step execution started
}

/**
 * Step data returned from storage
 */
export interface Step {
  id: string
  runId: string
  name: string
  index: number
  status: 'completed' | 'failed' | 'cancelled'
  output: unknown | null
  error: string | null
  startedAt: string
  completedAt: string | null
}

/**
 * Log data for creating a new log
 */
export interface CreateLogInput {
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data?: unknown
}

/**
 * Log data returned from storage
 */
export interface Log {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown | null
  createdAt: string
}

export interface ProgressData {
  current: number
  total?: number
  message?: string
}

export interface ClaimOptions {
  excludeConcurrencyKeys?: string[]
}

export type DatabaseBackend = 'generic' | 'postgres'

/**
 * Data for updating a run
 */
export interface UpdateRunData {
  status?: RunStatus
  currentStepIndex?: number
  progress?: ProgressData | null
  output?: unknown
  error?: string | null
  leaseOwner?: string | null
  leaseExpiresAt?: string | null
  startedAt?: string
  completedAt?: string
}

/**
 * Unified storage interface used by the runtime.
 */
export interface Store<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  // Run lifecycle
  enqueue(input: CreateRunInput<TLabels>): Promise<Run<TLabels>>
  enqueueMany(inputs: CreateRunInput<TLabels>[]): Promise<Run<TLabels>[]>
  getRun<T extends Run<TLabels> = Run<TLabels>>(
    runId: string,
  ): Promise<T | null>
  getRuns<T extends Run<TLabels> = Run<TLabels>>(
    filter?: RunFilter<TLabels>,
  ): Promise<T[]>
  updateRun(runId: string, data: UpdateRunData): Promise<void>
  deleteRun(runId: string): Promise<void>

  // Lease management (all lease-holder writes guarded by leaseGeneration)
  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: ClaimOptions,
  ): Promise<Run<TLabels> | null>
  renewLease(
    runId: string,
    leaseGeneration: number,
    now: string,
    leaseMs: number,
  ): Promise<boolean>
  releaseExpiredLeases(now: string): Promise<number>
  completeRun(
    runId: string,
    leaseGeneration: number,
    output: unknown,
    completedAt: string,
  ): Promise<boolean>
  failRun(
    runId: string,
    leaseGeneration: number,
    error: string,
    completedAt: string,
  ): Promise<boolean>
  cancelRun(runId: string, now: string): Promise<boolean>

  // Steps (checkpoints)
  /**
   * Atomically persist a step checkpoint, guarded by lease generation.
   * Inserts the step record and advances currentStepIndex (for completed
   * steps only) in a single transaction. Returns null if the generation
   * does not match (lease was lost).
   */
  persistStep(
    runId: string,
    leaseGeneration: number,
    input: CreateStepInput,
  ): Promise<Step | null>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
  deleteSteps(runId: string): Promise<void>

  // Progress
  updateProgress(
    runId: string,
    leaseGeneration: number,
    progress: ProgressData | null,
  ): Promise<void>

  // Logs
  createLog(input: CreateLogInput): Promise<Log>
  getLogs(runId: string): Promise<Log[]>
}

/**
 * A client-safe subset of Run, excluding internal fields like
 * leaseOwner, leaseExpiresAt, idempotencyKey, concurrencyKey, and updatedAt.
 */
export type ClientRun<
  TLabels extends Record<string, string> = Record<string, string>,
> = Omit<
  Run<TLabels>,
  | 'idempotencyKey'
  | 'concurrencyKey'
  | 'leaseOwner'
  | 'leaseExpiresAt'
  | 'leaseGeneration'
  | 'updatedAt'
>

/**
 * Project a full Run to a ClientRun by stripping internal fields.
 */
export function toClientRun<
  TLabels extends Record<string, string> = Record<string, string>,
>(run: Run<TLabels>): ClientRun<TLabels> {
  const {
    idempotencyKey,
    concurrencyKey,
    leaseOwner,
    leaseExpiresAt,
    leaseGeneration,
    updatedAt,
    ...clientRun
  } = run
  return clientRun
}

/**
 * Validate label keys: alphanumeric, dash, underscore, dot, slash only
 */
const LABEL_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/

function validateLabels(labels: Record<string, string> | undefined): void {
  if (!labels) return
  for (const key of Object.keys(labels)) {
    if (!LABEL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid label key "${key}": must contain only alphanumeric characters, dashes, underscores, dots, and slashes`,
      )
    }
  }
}

function rowToRun(
  row: Database['durably_runs'] & { step_count?: number | bigint | null },
): Run {
  return {
    id: row.id,
    jobName: row.job_name,
    input: JSON.parse(row.input),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    concurrencyKey: row.concurrency_key,
    currentStepIndex: row.current_step_index,
    stepCount: Number(row.step_count ?? 0),
    progress: row.progress ? JSON.parse(row.progress) : null,
    output: row.output ? JSON.parse(row.output) : null,
    error: row.error,
    labels: JSON.parse(row.labels),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    leaseGeneration: row.lease_generation,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Convert database row to Step object
 */
function rowToStep(row: Database['durably_steps']): Step {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    index: row.index,
    status: row.status,
    output: row.output ? JSON.parse(row.output) : null,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

/**
 * Convert database row to Log object
 */
function rowToLog(row: Database['durably_logs']): Log {
  return {
    id: row.id,
    runId: row.run_id,
    stepName: row.step_name,
    level: row.level,
    message: row.message,
    data: row.data ? JSON.parse(row.data) : null,
    createdAt: row.created_at,
  }
}

/**
 * Create a Kysely-based Store implementation
 */
export function createKyselyStore(
  db: Kysely<Database>,
  backend: DatabaseBackend = 'generic',
): Store<Record<string, string>> {
  async function terminateRun(
    runId: string,
    leaseGeneration: number,
    completedAt: string,
    fields: {
      status: 'completed' | 'failed'
      output?: string
      error?: string | null
    },
  ): Promise<boolean> {
    const result = await db
      .updateTable('durably_runs')
      .set({
        ...fields,
        lease_owner: null,
        lease_expires_at: null,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .where('id', '=', runId)
      .where('status', '=', 'leased')
      .where('lease_generation', '=', leaseGeneration)
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  return {
    async enqueue(input: CreateRunInput): Promise<Run> {
      const now = new Date().toISOString()

      // Check for existing run with same idempotency key
      if (input.idempotencyKey) {
        const existing = await db
          .selectFrom('durably_runs')
          .selectAll()
          .where('job_name', '=', input.jobName)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst()

        if (existing) {
          return rowToRun(existing)
        }
      }

      validateLabels(input.labels)

      const id = ulid()
      const run: Database['durably_runs'] = {
        id,
        job_name: input.jobName,
        input: JSON.stringify(input.input),
        status: 'pending',
        idempotency_key: input.idempotencyKey ?? null,
        concurrency_key: input.concurrencyKey ?? null,
        current_step_index: 0,
        progress: null,
        output: null,
        error: null,
        labels: JSON.stringify(input.labels ?? {}),
        lease_owner: null,
        lease_expires_at: null,
        lease_generation: 0,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      }

      await db.insertInto('durably_runs').values(run).execute()

      // Insert normalized labels for indexed filtering
      const labelEntries = Object.entries(input.labels ?? {})
      if (labelEntries.length > 0) {
        await db
          .insertInto('durably_run_labels')
          .values(
            labelEntries.map(([key, value]) => ({
              run_id: id,
              key,
              value,
            })),
          )
          .execute()
      }

      return rowToRun(run)
    },

    async enqueueMany(inputs: CreateRunInput[]): Promise<Run[]> {
      if (inputs.length === 0) {
        return []
      }

      // Use transaction to ensure atomicity of idempotency checks and inserts
      return await db.transaction().execute(async (trx) => {
        const now = new Date().toISOString()
        const runs: Database['durably_runs'][] = []

        // Validate all labels upfront
        for (const input of inputs) {
          validateLabels(input.labels)
        }

        // Process inputs - check idempotency keys and create run objects
        for (const input of inputs) {
          // Check for existing run with same idempotency key
          if (input.idempotencyKey) {
            const existing = await trx
              .selectFrom('durably_runs')
              .selectAll()
              .where('job_name', '=', input.jobName)
              .where('idempotency_key', '=', input.idempotencyKey)
              .executeTakeFirst()

            if (existing) {
              runs.push(existing)
              continue
            }
          }

          const id = ulid()
          runs.push({
            id,
            job_name: input.jobName,
            input: JSON.stringify(input.input),
            status: 'pending',
            idempotency_key: input.idempotencyKey ?? null,
            concurrency_key: input.concurrencyKey ?? null,
            current_step_index: 0,
            progress: null,
            output: null,
            error: null,
            labels: JSON.stringify(input.labels ?? {}),
            lease_owner: null,
            lease_expires_at: null,
            lease_generation: 0,
            started_at: null,
            completed_at: null,
            created_at: now,
            updated_at: now,
          })
        }

        // Insert all new runs in a single batch
        const newRuns = runs.filter((r) => r.created_at === now)
        if (newRuns.length > 0) {
          await trx.insertInto('durably_runs').values(newRuns).execute()

          // Insert normalized labels for indexed filtering
          const labelRows: { run_id: string; key: string; value: string }[] = []
          for (const run of newRuns) {
            const labels = JSON.parse(run.labels) as Record<string, string>
            for (const [key, value] of Object.entries(labels)) {
              labelRows.push({ run_id: run.id, key, value })
            }
          }
          if (labelRows.length > 0) {
            await trx
              .insertInto('durably_run_labels')
              .values(labelRows)
              .execute()
          }
        }

        return runs.map(rowToRun)
      })
    },

    async getRun<T extends Run = Run>(runId: string): Promise<T | null> {
      const row = await db
        .selectFrom('durably_runs')
        .leftJoin('durably_steps', 'durably_runs.id', 'durably_steps.run_id')
        .selectAll('durably_runs')
        .select((eb) =>
          eb.fn.count<number>('durably_steps.id').as('step_count'),
        )
        .where('durably_runs.id', '=', runId)
        .groupBy('durably_runs.id')
        .executeTakeFirst()

      return row ? (rowToRun(row) as T) : null
    },

    async getRuns<T extends Run = Run>(filter?: RunFilter): Promise<T[]> {
      let query = db
        .selectFrom('durably_runs')
        .leftJoin('durably_steps', 'durably_runs.id', 'durably_steps.run_id')
        .selectAll('durably_runs')
        .select((eb) =>
          eb.fn.count<number>('durably_steps.id').as('step_count'),
        )
        .groupBy('durably_runs.id')

      if (filter?.status) {
        query = query.where('durably_runs.status', '=', filter.status)
      }
      if (filter?.jobName) {
        if (Array.isArray(filter.jobName)) {
          if (filter.jobName.length > 0) {
            query = query.where('durably_runs.job_name', 'in', filter.jobName)
          }
        } else {
          query = query.where('durably_runs.job_name', '=', filter.jobName)
        }
      }
      if (filter?.labels) {
        const labels = filter.labels as Record<string, string>
        validateLabels(labels)
        for (const [key, value] of Object.entries(labels)) {
          if (value === undefined) continue
          query = query.where((eb) =>
            eb.exists(
              eb
                .selectFrom('durably_run_labels')
                .select(sql.lit(1).as('one'))
                .whereRef('durably_run_labels.run_id', '=', 'durably_runs.id')
                .where('durably_run_labels.key', '=', key)
                .where('durably_run_labels.value', '=', value),
            ),
          )
        }
      }

      query = query.orderBy('durably_runs.created_at', 'desc')

      if (filter?.limit !== undefined) {
        query = query.limit(filter.limit)
      }
      if (filter?.offset !== undefined) {
        // SQLite requires LIMIT when using OFFSET
        if (filter.limit === undefined) {
          query = query.limit(-1) // -1 means unlimited in SQLite
        }
        query = query.offset(filter.offset)
      }

      const rows = await query.execute()
      return rows.map(rowToRun) as T[]
    },

    async updateRun(runId, data) {
      const now = new Date().toISOString()
      const status = data.status

      await db
        .updateTable('durably_runs')
        .set({
          status,
          current_step_index: data.currentStepIndex,
          progress:
            data.progress !== undefined
              ? data.progress
                ? JSON.stringify(data.progress)
                : null
              : undefined,
          output:
            data.output !== undefined ? JSON.stringify(data.output) : undefined,
          error: data.error,
          lease_owner:
            data.leaseOwner !== undefined ? data.leaseOwner : undefined,
          lease_expires_at:
            data.leaseExpiresAt !== undefined ? data.leaseExpiresAt : undefined,
          started_at: data.startedAt,
          completed_at: data.completedAt,
          updated_at: now,
        })
        .where('id', '=', runId)
        .execute()
    },

    async deleteRun(runId: string) {
      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom('durably_steps')
          .where('run_id', '=', runId)
          .execute()
        await trx
          .deleteFrom('durably_logs')
          .where('run_id', '=', runId)
          .execute()
        await trx
          .deleteFrom('durably_run_labels')
          .where('run_id', '=', runId)
          .execute()
        await trx.deleteFrom('durably_runs').where('id', '=', runId).execute()
      })
    },

    async claimNext(
      workerId: string,
      now: string,
      leaseMs: number,
      options?: ClaimOptions,
    ): Promise<Run | null> {
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
      const excludeConcurrencyKeys = options?.excludeConcurrencyKeys ?? []
      const activeLeaseGuard = sql<boolean>`
        (
          concurrency_key IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM durably_runs AS active
            WHERE active.concurrency_key = durably_runs.concurrency_key
              AND active.id <> durably_runs.id
              AND active.status = 'leased'
              AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at > ${now}
          )
        )
      `

      if (backend === 'postgres') {
        return await db.transaction().execute(async (trx) => {
          const skipKeys = [...excludeConcurrencyKeys]

          // Loop: on concurrency-key conflict, exclude that key and retry
          // to find the next eligible candidate in the same transaction.
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

            // Step 1: Find and lock a candidate row
            const candidateResult = await sql<{
              id: string
              concurrency_key: string | null
            }>`
              SELECT id, concurrency_key
              FROM durably_runs
              WHERE
                (
                  status = 'pending'
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

            // Step 2: If the candidate has a concurrency key, serialize via
            // advisory lock and re-verify with a fresh snapshot (READ COMMITTED
            // gives each statement its own snapshot).
            if (candidate.concurrency_key) {
              await sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.concurrency_key}))`.execute(
                trx,
              )

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
                // Key is occupied — exclude it and try the next candidate
                skipKeys.push(candidate.concurrency_key)
                continue
              }
            }

            // Step 3: Claim the candidate (increment lease_generation)
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
            return rowToRun({ ...row, step_count: 0 })
          }
        })
      }

      let subquery = db
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

      if (excludeConcurrencyKeys.length > 0) {
        subquery = subquery.where((eb) =>
          eb.or([
            eb('concurrency_key', 'is', null),
            eb('concurrency_key', 'not in', excludeConcurrencyKeys),
          ]),
        )
      }

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
        .where('id', '=', (eb) =>
          eb.selectFrom(subquery.as('sub')).select('id'),
        )
        .returningAll()
        .executeTakeFirst()

      if (!row) return null
      return rowToRun({ ...row, step_count: 0 })
    },

    async renewLease(
      runId: string,
      leaseGeneration: number,
      now: string,
      leaseMs: number,
    ): Promise<boolean> {
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
      const result = await db
        .updateTable('durably_runs')
        .set({
          lease_expires_at: leaseExpiresAt,
          updated_at: now,
        })
        .where('id', '=', runId)
        .where('status', '=', 'leased')
        .where('lease_generation', '=', leaseGeneration)
        .where('lease_expires_at', '>', now)
        .executeTakeFirst()

      return Number(result.numUpdatedRows) > 0
    },

    async releaseExpiredLeases(now: string): Promise<number> {
      const result = await db
        .updateTable('durably_runs')
        .set({
          status: 'pending',
          lease_owner: null,
          lease_expires_at: null,
          updated_at: now,
        })
        .where('status', '=', 'leased')
        .where('lease_expires_at', 'is not', null)
        .where('lease_expires_at', '<=', now)
        .executeTakeFirst()

      return Number(result.numUpdatedRows)
    },

    async completeRun(
      runId: string,
      leaseGeneration: number,
      output: unknown,
      completedAt: string,
    ): Promise<boolean> {
      return terminateRun(runId, leaseGeneration, completedAt, {
        status: 'completed',
        output: JSON.stringify(output),
        error: null,
      })
    },

    async failRun(
      runId: string,
      leaseGeneration: number,
      error: string,
      completedAt: string,
    ): Promise<boolean> {
      return terminateRun(runId, leaseGeneration, completedAt, {
        status: 'failed',
        error,
      })
    },

    async cancelRun(runId: string, now: string): Promise<boolean> {
      const result = await db
        .updateTable('durably_runs')
        .set({
          status: 'cancelled',
          lease_owner: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where('id', '=', runId)
        .where('status', 'in', ['pending', 'leased'])
        .executeTakeFirst()

      return Number(result.numUpdatedRows) > 0
    },

    async persistStep(
      runId: string,
      leaseGeneration: number,
      input: CreateStepInput,
    ): Promise<Step | null> {
      const completedAt = new Date().toISOString()
      const id = ulid()
      const outputJson =
        input.output !== undefined ? JSON.stringify(input.output) : null
      const errorValue = input.error ?? null

      return await db.transaction().execute(async (trx) => {
        // Atomic INSERT...SELECT: the step is only inserted if the
        // lease generation matches. Single statement, no TOCTOU.
        const insertResult = await sql`
          INSERT INTO durably_steps (id, run_id, name, "index", status, output, error, started_at, completed_at)
          SELECT ${id}, ${runId}, ${input.name}, ${input.index}, ${input.status},
                 ${outputJson}, ${errorValue}, ${input.startedAt}, ${completedAt}
          FROM durably_runs
          WHERE id = ${runId} AND lease_generation = ${leaseGeneration}
        `.execute(trx)

        if (Number(insertResult.numAffectedRows) === 0) return null

        // Advance step index for completed steps only
        if (input.status === 'completed') {
          await trx
            .updateTable('durably_runs')
            .set({
              current_step_index: input.index + 1,
              updated_at: completedAt,
            })
            .where('id', '=', runId)
            .where('lease_generation', '=', leaseGeneration)
            .execute()
        }

        return {
          id,
          runId,
          name: input.name,
          index: input.index,
          status: input.status,
          output: input.output !== undefined ? input.output : null,
          error: errorValue,
          startedAt: input.startedAt,
          completedAt,
        } as Step
      })
    },

    async deleteSteps(runId: string): Promise<void> {
      await db.deleteFrom('durably_steps').where('run_id', '=', runId).execute()
      await db.deleteFrom('durably_logs').where('run_id', '=', runId).execute()
    },

    async getSteps(runId: string): Promise<Step[]> {
      const rows = await db
        .selectFrom('durably_steps')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('index', 'asc')
        .execute()

      return rows.map(rowToStep)
    },

    async getCompletedStep(runId: string, name: string): Promise<Step | null> {
      const row = await db
        .selectFrom('durably_steps')
        .selectAll()
        .where('run_id', '=', runId)
        .where('name', '=', name)
        .where('status', '=', 'completed')
        .executeTakeFirst()

      return row ? rowToStep(row) : null
    },

    async updateProgress(
      runId: string,
      leaseGeneration: number,
      progress: ProgressData | null,
    ): Promise<void> {
      await db
        .updateTable('durably_runs')
        .set({
          progress: progress ? JSON.stringify(progress) : null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', runId)
        .where('lease_generation', '=', leaseGeneration)
        .execute()
    },

    async createLog(input: CreateLogInput): Promise<Log> {
      const now = new Date().toISOString()
      const id = ulid()

      const log: Database['durably_logs'] = {
        id,
        run_id: input.runId,
        step_name: input.stepName,
        level: input.level,
        message: input.message,
        data: input.data !== undefined ? JSON.stringify(input.data) : null,
        created_at: now,
      }

      await db.insertInto('durably_logs').values(log).execute()

      return rowToLog(log)
    },

    async getLogs(runId: string): Promise<Log[]> {
      const rows = await db
        .selectFrom('durably_logs')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('created_at', 'asc')
        .execute()

      return rows.map(rowToLog)
    },
  }
}
