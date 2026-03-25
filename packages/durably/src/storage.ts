import { type Kysely, sql } from 'kysely'
import { monotonicFactory } from 'ulidx'
import { claimNextPostgres } from './claim-postgres'
import { claimNextSqlite } from './claim-sqlite'
import type { Disposition } from './job'
import type { Database } from './schema'
import { rowToLog, rowToRun, rowToStep, validateLabels } from './transformers'

const ulid = monotonicFactory()

export type RunStatus =
  | 'pending'
  | 'leased'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Run statuses that represent terminal (non-active) states */
const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled']

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
  coalesce?: 'skip'
}

export interface EnqueueResult<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  run: Run<TLabels>
  disposition: Disposition
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
  completedStepCount: number
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
  enqueue(input: CreateRunInput<TLabels>): Promise<EnqueueResult<TLabels>>
  enqueueMany(
    inputs: CreateRunInput<TLabels>[],
  ): Promise<EnqueueResult<TLabels>[]>
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

  // Purge
  purgeRuns(options: { olderThan: string; limit?: number }): Promise<number>

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
 * Simple async mutex for serializing write operations.
 * Prevents SQLITE_BUSY errors with libsql, which opens separate
 * connections for transactions causing write/write conflicts.
 */
function createWriteMutex() {
  let queue: Promise<void> = Promise.resolve()

  return async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = queue
    queue = next
    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}

/**
 * Create a Kysely-based Store implementation
 */
export function createKyselyStore(
  db: Kysely<Database>,
  backend: DatabaseBackend = 'generic',
): Store<Record<string, string>> {
  const withWriteLock = createWriteMutex()

  /** Delete runs and all associated data (steps, logs, labels) in dependency order */
  async function cascadeDeleteRuns(
    trx: Kysely<Database>,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return
    await trx.deleteFrom('durably_steps').where('run_id', 'in', ids).execute()
    await trx.deleteFrom('durably_logs').where('run_id', 'in', ids).execute()
    await trx
      .deleteFrom('durably_run_labels')
      .where('run_id', 'in', ids)
      .execute()
    await trx.deleteFrom('durably_runs').where('id', 'in', ids).execute()
  }

  async function insertLabelRows(
    executor: Kysely<Database>,
    runId: string,
    labels: Record<string, string> | undefined,
  ): Promise<void> {
    const entries = Object.entries(labels ?? {})
    if (entries.length > 0) {
      await executor
        .insertInto('durably_run_labels')
        .values(entries.map(([key, value]) => ({ run_id: runId, key, value })))
        .execute()
    }
  }

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

  const store: Store<Record<string, string>> = {
    async enqueue(input: CreateRunInput): Promise<EnqueueResult> {
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
          return { run: rowToRun(existing), disposition: 'idempotent' }
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
        completed_step_count: 0,
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

      // Use transaction to ensure run + label rows are atomic
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('durably_runs').values(run).execute()
        await insertLabelRows(trx, id, input.labels)
      })

      return { run: rowToRun(run), disposition: 'created' }
    },

    async enqueueMany(inputs: CreateRunInput[]): Promise<EnqueueResult[]> {
      if (inputs.length === 0) {
        return []
      }
      // Use transaction to ensure atomicity of idempotency checks and inserts
      return await db.transaction().execute(async (trx) => {
        const now = new Date().toISOString()
        const results: {
          row: Database['durably_runs']
          disposition: Disposition
        }[] = []

        // Validate all labels upfront
        for (const input of inputs) {
          validateLabels(input.labels)
        }

        // Process inputs - check idempotency keys and create run objects
        const allLabelRows: Array<{
          run_id: string
          key: string
          value: string
        }> = []
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
              results.push({ row: existing, disposition: 'idempotent' })
              continue
            }
          }

          const id = ulid()
          if (input.labels) {
            for (const [key, value] of Object.entries(input.labels)) {
              allLabelRows.push({ run_id: id, key, value })
            }
          }
          const row: Database['durably_runs'] = {
            id,
            job_name: input.jobName,
            input: JSON.stringify(input.input),
            status: 'pending',
            idempotency_key: input.idempotencyKey ?? null,
            concurrency_key: input.concurrencyKey ?? null,
            current_step_index: 0,
            completed_step_count: 0,
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
          results.push({ row, disposition: 'created' })
        }

        // Insert all new runs in a single batch
        const newRows = results
          .filter((r) => r.disposition === 'created')
          .map((r) => r.row)
        if (newRows.length > 0) {
          await trx.insertInto('durably_runs').values(newRows).execute()

          // Insert normalized labels for indexed filtering (single batch)
          if (allLabelRows.length > 0) {
            await trx
              .insertInto('durably_run_labels')
              .values(allLabelRows)
              .execute()
          }
        }

        return results.map((r) => ({
          run: rowToRun(r.row),
          disposition: r.disposition,
        }))
      })
    },

    async getRun<T extends Run = Run>(runId: string): Promise<T | null> {
      const row = await db
        .selectFrom('durably_runs')
        .selectAll()
        .where('id', '=', runId)
        .executeTakeFirst()

      return row ? (rowToRun(row) as T) : null
    },

    async getRuns<T extends Run = Run>(filter?: RunFilter): Promise<T[]> {
      let query = db.selectFrom('durably_runs').selectAll()

      if (filter?.status) {
        query = query.where('status', '=', filter.status)
      }
      if (filter?.jobName) {
        if (Array.isArray(filter.jobName)) {
          if (filter.jobName.length > 0) {
            query = query.where('job_name', 'in', filter.jobName)
          }
        } else {
          query = query.where('job_name', '=', filter.jobName)
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

      query = query.orderBy('created_at', 'desc')

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
        await cascadeDeleteRuns(trx, [runId])
      })
    },

    async purgeRuns(options: {
      olderThan: string
      limit?: number
    }): Promise<number> {
      const limit = options.limit ?? 500

      return await db.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('durably_runs')
          .select('id')
          .where('status', 'in', TERMINAL_STATUSES)
          .where('completed_at', '<', options.olderThan)
          .orderBy('completed_at', 'asc')
          .limit(limit)
          .execute()

        if (rows.length === 0) return 0

        const ids = rows.map((r) => r.id)
        await cascadeDeleteRuns(trx, ids)
        return ids.length
      })
    },

    async claimNext(
      workerId: string,
      now: string,
      leaseMs: number,
    ): Promise<Run | null> {
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
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

      return backend === 'postgres'
        ? claimNextPostgres(db, workerId, now, leaseExpiresAt, activeLeaseGuard)
        : claimNextSqlite(db, workerId, now, leaseExpiresAt, activeLeaseGuard)
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
          WHERE id = ${runId} AND status = 'leased' AND lease_generation = ${leaseGeneration}
        `.execute(trx)

        if (Number(insertResult.numAffectedRows) === 0) return null

        // Advance step index and increment completed_step_count for completed steps
        if (input.status === 'completed') {
          await trx
            .updateTable('durably_runs')
            .set({
              current_step_index: input.index + 1,
              completed_step_count: sql`completed_step_count + 1`,
              updated_at: completedAt,
            })
            .where('id', '=', runId)
            .where('status', '=', 'leased')
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
        .where('status', '=', 'leased')
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

  // SQLite/libsql: wrap mutating methods with write lock to prevent SQLITE_BUSY.
  // libsql opens separate connections for transactions, so concurrent writes
  // from the same Kysely instance can conflict. The mutex serializes writes
  // within a single process. Reads are not locked.
  //
  // PostgreSQL: skip the mutex entirely. PostgreSQL handles concurrent writes
  // natively via MVCC, advisory locks, and FOR UPDATE SKIP LOCKED.
  if (backend !== 'postgres') {
    const mutatingKeys = [
      'enqueue',
      'enqueueMany',
      'updateRun',
      'deleteRun',
      'purgeRuns',
      'claimNext',
      'renewLease',
      'releaseExpiredLeases',
      'completeRun',
      'failRun',
      'cancelRun',
      'persistStep',
      'deleteSteps',
      'updateProgress',
      'createLog',
    ] as const

    for (const key of mutatingKeys) {
      const original = store[key] as (...args: unknown[]) => Promise<unknown>
      ;(store as unknown as Record<string, unknown>)[key] = (
        ...args: unknown[]
      ): Promise<unknown> => withWriteLock(() => original.apply(store, args))
    }
  }

  return store
}
