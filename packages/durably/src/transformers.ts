import type { Database } from './schema'
import type { Log, Run, Step } from './storage'

/** Convert database row to Run object */
export function rowToRun(row: Database['durably_runs']): Run {
  return {
    id: row.id,
    jobName: row.job_name,
    input: JSON.parse(row.input),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    concurrencyKey: row.concurrency_key,
    currentStepIndex: row.current_step_index,
    completedStepCount: row.completed_step_count,
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

/** Convert database row to Step object */
export function rowToStep(row: Database['durably_steps']): Step {
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

/** Convert database row to Log object */
export function rowToLog(row: Database['durably_logs']): Log {
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

/** Validate label keys: alphanumeric, dash, underscore, dot, slash only */
const LABEL_KEY_PATTERN = /^[a-zA-Z0-9\-_./]+$/

export function validateLabels(
  labels: Record<string, string> | undefined,
): void {
  if (!labels) return
  for (const key of Object.keys(labels)) {
    if (!LABEL_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid label key "${key}": must contain only alphanumeric characters, dashes, underscores, dots, and slashes`,
      )
    }
  }
}
