import type { Kysely } from 'kysely'
import { ulid } from 'ulidx'
import type { Database } from './schema'

/**
 * Run data for creating a new run
 */
export interface CreateRunInput {
  jobName: string
  payload: unknown
  idempotencyKey?: string
  concurrencyKey?: string
}

/**
 * Run data returned from storage
 */
export interface Run {
  id: string
  jobName: string
  payload: unknown
  status: 'pending' | 'running' | 'completed' | 'failed'
  idempotencyKey: string | null
  concurrencyKey: string | null
  currentStepIndex: number
  progress: { current: number; total?: number; message?: string } | null
  output: unknown | null
  error: string | null
  heartbeatAt: string
  createdAt: string
  updatedAt: string
}

/**
 * Run update data
 */
export interface UpdateRunInput {
  status?: 'pending' | 'running' | 'completed' | 'failed'
  currentStepIndex?: number
  progress?: { current: number; total?: number; message?: string } | null
  output?: unknown
  error?: string | null
  heartbeatAt?: string
}

/**
 * Run filter options
 */
export interface RunFilter {
  status?: 'pending' | 'running' | 'completed' | 'failed'
  jobName?: string
}

/**
 * Step data for creating a new step
 */
export interface CreateStepInput {
  runId: string
  name: string
  index: number
  status: 'completed' | 'failed'
  output?: unknown
  error?: string
}

/**
 * Step data returned from storage
 */
export interface Step {
  id: string
  runId: string
  name: string
  index: number
  status: 'completed' | 'failed'
  output: unknown | null
  error: string | null
  startedAt: string
  completedAt: string | null
}

/**
 * Storage interface for database operations
 */
export interface Storage {
  // Run operations
  createRun(input: CreateRunInput): Promise<Run>
  updateRun(runId: string, data: UpdateRunInput): Promise<void>
  getRun(runId: string): Promise<Run | null>
  getRuns(filter?: RunFilter): Promise<Run[]>
  getNextPendingRun(excludeConcurrencyKeys: string[]): Promise<Run | null>

  // Step operations
  createStep(input: CreateStepInput): Promise<Step>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
}

/**
 * Convert database row to Run object
 */
function rowToRun(row: Database['runs']): Run {
  return {
    id: row.id,
    jobName: row.job_name,
    payload: JSON.parse(row.payload),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    concurrencyKey: row.concurrency_key,
    currentStepIndex: row.current_step_index,
    progress: row.progress ? JSON.parse(row.progress) : null,
    output: row.output ? JSON.parse(row.output) : null,
    error: row.error,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Convert database row to Step object
 */
function rowToStep(row: Database['steps']): Step {
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
 * Create a Kysely-based Storage implementation
 */
export function createKyselyStorage(db: Kysely<Database>): Storage {
  return {
    async createRun(input: CreateRunInput): Promise<Run> {
      const now = new Date().toISOString()

      // Check for existing run with same idempotency key
      if (input.idempotencyKey) {
        const existing = await db
          .selectFrom('runs')
          .selectAll()
          .where('job_name', '=', input.jobName)
          .where('idempotency_key', '=', input.idempotencyKey)
          .executeTakeFirst()

        if (existing) {
          return rowToRun(existing)
        }
      }

      const id = ulid()
      const run: Database['runs'] = {
        id,
        job_name: input.jobName,
        payload: JSON.stringify(input.payload),
        status: 'pending',
        idempotency_key: input.idempotencyKey ?? null,
        concurrency_key: input.concurrencyKey ?? null,
        current_step_index: 0,
        progress: null,
        output: null,
        error: null,
        heartbeat_at: now,
        created_at: now,
        updated_at: now,
      }

      await db.insertInto('runs').values(run).execute()

      return rowToRun(run)
    },

    async updateRun(runId: string, data: UpdateRunInput): Promise<void> {
      const now = new Date().toISOString()
      const updates: Partial<Database['runs']> = {
        updated_at: now,
      }

      if (data.status !== undefined) updates.status = data.status
      if (data.currentStepIndex !== undefined) updates.current_step_index = data.currentStepIndex
      if (data.progress !== undefined) updates.progress = data.progress ? JSON.stringify(data.progress) : null
      if (data.output !== undefined) updates.output = JSON.stringify(data.output) ?? null
      if (data.error !== undefined) updates.error = data.error
      if (data.heartbeatAt !== undefined) updates.heartbeat_at = data.heartbeatAt

      await db.updateTable('runs').set(updates).where('id', '=', runId).execute()
    },

    async getRun(runId: string): Promise<Run | null> {
      const row = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst()

      return row ? rowToRun(row) : null
    },

    async getRuns(filter?: RunFilter): Promise<Run[]> {
      let query = db.selectFrom('runs').selectAll()

      if (filter?.status) {
        query = query.where('status', '=', filter.status)
      }
      if (filter?.jobName) {
        query = query.where('job_name', '=', filter.jobName)
      }

      query = query.orderBy('created_at', 'desc')

      const rows = await query.execute()
      return rows.map(rowToRun)
    },

    async getNextPendingRun(excludeConcurrencyKeys: string[]): Promise<Run | null> {
      let query = db
        .selectFrom('runs')
        .selectAll()
        .where('status', '=', 'pending')
        .orderBy('created_at', 'asc')
        .limit(1)

      if (excludeConcurrencyKeys.length > 0) {
        query = query.where((eb) =>
          eb.or([eb('concurrency_key', 'is', null), eb('concurrency_key', 'not in', excludeConcurrencyKeys)])
        )
      }

      const row = await query.executeTakeFirst()
      return row ? rowToRun(row) : null
    },

    async createStep(input: CreateStepInput): Promise<Step> {
      const now = new Date().toISOString()
      const id = ulid()

      const step: Database['steps'] = {
        id,
        run_id: input.runId,
        name: input.name,
        index: input.index,
        status: input.status,
        output: input.output !== undefined ? JSON.stringify(input.output) : null,
        error: input.error ?? null,
        started_at: now,
        completed_at: now,
      }

      await db.insertInto('steps').values(step).execute()

      return rowToStep(step)
    },

    async getSteps(runId: string): Promise<Step[]> {
      const rows = await db
        .selectFrom('steps')
        .selectAll()
        .where('run_id', '=', runId)
        .orderBy('index', 'asc')
        .execute()

      return rows.map(rowToStep)
    },

    async getCompletedStep(runId: string, name: string): Promise<Step | null> {
      const row = await db
        .selectFrom('steps')
        .selectAll()
        .where('run_id', '=', runId)
        .where('name', '=', name)
        .where('status', '=', 'completed')
        .executeTakeFirst()

      return row ? rowToStep(row) : null
    },
  }
}
