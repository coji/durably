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
  /**
   * Deprecated compatibility alias for legacy heartbeat-based runtime.
   */
  heartbeatAt: string
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
 * Step data for creating a new step
 */
export interface CreateStepInput {
  runId: string
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

export interface QueueStore<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  enqueue(input: CreateRunInput<TLabels>): Promise<Run<TLabels>>
  enqueueMany(inputs: CreateRunInput<TLabels>[]): Promise<Run<TLabels>[]>
  getRun<T extends Run<TLabels> = Run<TLabels>>(
    runId: string,
  ): Promise<T | null>
  getRuns<T extends Run<TLabels> = Run<TLabels>>(
    filter?: RunFilter<TLabels>,
  ): Promise<T[]>
  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: ClaimOptions,
  ): Promise<Run<TLabels> | null>
  renewLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): Promise<boolean>
  releaseExpiredLeases(now: string): Promise<number>
  completeRun(
    runId: string,
    workerId: string,
    output: unknown,
    completedAt: string,
  ): Promise<boolean>
  failRun(
    runId: string,
    workerId: string,
    error: string,
    completedAt: string,
  ): Promise<boolean>
  cancelRun(runId: string, now: string): Promise<void>
  deleteRun(runId: string): Promise<void>
}

export interface CheckpointStore {
  createStep(input: CreateStepInput): Promise<Step>
  deleteSteps(runId: string): Promise<void>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
  createLog(input: CreateLogInput): Promise<Log>
  getLogs(runId: string): Promise<Log[]>
  advanceRunStepIndex(runId: string, stepIndex: number): Promise<void>
  updateProgress(runId: string, progress: ProgressData | null): Promise<void>
}

/**
 * Combined storage surface used by the runtime.
 */
export interface Storage<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  queue: QueueStore<TLabels>
  checkpoint: CheckpointStore
  createRun(input: CreateRunInput<TLabels>): Promise<Run<TLabels>>
  batchCreateRuns(inputs: CreateRunInput<TLabels>[]): Promise<Run<TLabels>[]>
  getRun<T extends Run<TLabels> = Run<TLabels>>(
    runId: string,
  ): Promise<T | null>
  getRuns<T extends Run<TLabels> = Run<TLabels>>(
    filter?: RunFilter<TLabels>,
  ): Promise<T[]>
  claimNextPendingRun(
    excludeConcurrencyKeys: string[],
  ): Promise<Run<TLabels> | null>
  updateRun(
    runId: string,
    data: {
      status?: RunStatus | 'running'
      currentStepIndex?: number
      progress?: ProgressData | null
      output?: unknown
      error?: string | null
      heartbeatAt?: string
      leaseOwner?: string | null
      leaseExpiresAt?: string | null
      startedAt?: string
      completedAt?: string
    },
  ): Promise<void>
  deleteRun(runId: string): Promise<void>
  createStep(input: CreateStepInput): Promise<Step>
  deleteSteps(runId: string): Promise<void>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
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
    heartbeatAt: row.lease_expires_at ?? row.updated_at,
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
 * Create a Kysely-based QueueStore implementation
 */
export function createKyselyQueueStore(
  db: Kysely<Database>,
  backend: DatabaseBackend = 'generic',
): QueueStore<Record<string, string>> {
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
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      }

      await db.insertInto('durably_runs').values(run).execute()

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
          query = query.where(
            sql`json_extract(durably_runs.labels, ${`$."${key}"`})`,
            '=',
            value,
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

            // Step 3: Claim the candidate
            const result = await sql<Database['durably_runs']>`
              UPDATE durably_runs
              SET
                status = 'leased',
                lease_owner = ${workerId},
                lease_expires_at = ${leaseExpiresAt},
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
      workerId: string,
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
        .where('lease_owner', '=', workerId)
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
      workerId: string,
      output: unknown,
      completedAt: string,
    ): Promise<boolean> {
      const result = await db
        .updateTable('durably_runs')
        .set({
          status: 'completed',
          output: JSON.stringify(output),
          error: null,
          lease_owner: null,
          lease_expires_at: null,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .where('id', '=', runId)
        .where('status', '=', 'leased')
        .where('lease_owner', '=', workerId)
        .executeTakeFirst()

      return Number(result.numUpdatedRows) > 0
    },

    async failRun(
      runId: string,
      workerId: string,
      error: string,
      completedAt: string,
    ): Promise<boolean> {
      const result = await db
        .updateTable('durably_runs')
        .set({
          status: 'failed',
          error,
          lease_owner: null,
          lease_expires_at: null,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .where('id', '=', runId)
        .where('status', '=', 'leased')
        .where('lease_owner', '=', workerId)
        .executeTakeFirst()

      return Number(result.numUpdatedRows) > 0
    },

    async cancelRun(runId: string, now: string): Promise<void> {
      await db
        .updateTable('durably_runs')
        .set({
          status: 'cancelled',
          lease_owner: null,
          lease_expires_at: null,
          completed_at: now,
          updated_at: now,
        })
        .where('id', '=', runId)
        .execute()
    },

    async deleteRun(runId: string): Promise<void> {
      await db.deleteFrom('durably_runs').where('id', '=', runId).execute()
    },
  }
}

export function createKyselyCheckpointStore(
  db: Kysely<Database>,
): CheckpointStore {
  return {
    async createStep(input: CreateStepInput): Promise<Step> {
      const completedAt = new Date().toISOString()
      const id = ulid()

      const step: Database['durably_steps'] = {
        id,
        run_id: input.runId,
        name: input.name,
        index: input.index,
        status: input.status,
        output:
          input.output !== undefined ? JSON.stringify(input.output) : null,
        error: input.error ?? null,
        started_at: input.startedAt,
        completed_at: completedAt,
      }

      await db.insertInto('durably_steps').values(step).execute()

      return rowToStep(step)
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

    async advanceRunStepIndex(runId: string, stepIndex: number): Promise<void> {
      await db
        .updateTable('durably_runs')
        .set({
          current_step_index: stepIndex,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', runId)
        .execute()
    },

    async updateProgress(
      runId: string,
      progress: ProgressData | null,
    ): Promise<void> {
      await db
        .updateTable('durably_runs')
        .set({
          progress: progress ? JSON.stringify(progress) : null,
          updated_at: new Date().toISOString(),
        })
        .where('id', '=', runId)
        .execute()
    },
  }
}

export function createKyselyStorage(
  db: Kysely<Database>,
  backend: DatabaseBackend = 'generic',
): Storage<Record<string, string>> {
  const queue = createKyselyQueueStore(db, backend)
  const checkpoint = createKyselyCheckpointStore(db)

  return {
    queue,
    checkpoint,
    createRun: queue.enqueue,
    batchCreateRuns: queue.enqueueMany,
    getRun: queue.getRun,
    getRuns: queue.getRuns,
    claimNextPendingRun(excludeConcurrencyKeys: string[]) {
      return queue.claimNext('legacy-claim', new Date().toISOString(), 30_000, {
        excludeConcurrencyKeys,
      })
    },
    async updateRun(runId, data) {
      const now = new Date().toISOString()
      const status = data.status === 'running' ? 'leased' : data.status

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
            data.leaseExpiresAt !== undefined
              ? data.leaseExpiresAt
              : data.heartbeatAt,
          started_at: data.startedAt,
          completed_at: data.completedAt,
          updated_at: now,
        })
        .where('id', '=', runId)
        .execute()
    },
    async deleteRun(runId: string) {
      await checkpoint.deleteSteps(runId)
      await queue.deleteRun(runId)
    },
    createStep: checkpoint.createStep,
    deleteSteps: checkpoint.deleteSteps,
    getSteps: checkpoint.getSteps,
    getCompletedStep: checkpoint.getCompletedStep,
    createLog: checkpoint.createLog,
    getLogs: checkpoint.getLogs,
  }
}
