/**
 * Database schema types for Durably
 */

export interface RunsTable {
  id: string
  job_name: string
  input: string // JSON
  status:
    | 'pending'
    | 'leased'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
  idempotency_key: string | null
  concurrency_key: string | null
  current_step_index: number
  completed_step_count: number
  progress: string | null // JSON: { current, total, message }
  output: string | null // JSON
  error: string | null
  labels: string // JSON: Record<string, string>
  lease_owner: string | null
  lease_expires_at: string | null // ISO8601
  lease_generation: number
  waiting_on_wait_id: string | null
  resume_claimed_at: string | null // Original first claim after a wait resolved
  started_at: string | null // ISO8601
  completed_at: string | null // ISO8601
  created_at: string // ISO8601
  updated_at: string // ISO8601
}

export interface StepsTable {
  id: string
  run_id: string
  name: string
  index: number
  status: 'completed' | 'failed' | 'cancelled'
  output: string | null // JSON
  error: string | null
  started_at: string // ISO8601
  completed_at: string | null // ISO8601
}

export interface StepAttemptsTable {
  id: string
  run_id: string
  step_name: string
  step_index: number
  lease_generation: number
  status: 'started' | 'completed' | 'failed'
  metadata: string | null // Serialized JSON
  error: string | null
  started_at: string
  completed_at: string | null
}

export interface LogsTable {
  id: string
  run_id: string
  step_name: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: string | null // JSON
  created_at: string // ISO8601
}

export interface RunLabelsTable {
  run_id: string
  key: string
  value: string
}

export interface SchemaVersionsTable {
  version: number
  applied_at: string // ISO8601
}

export interface WaitsTable {
  id: string
  run_id: string
  name: string
  metadata: string | null
  status: 'pending' | 'resolved' | 'cancelled' | 'closed'
  payload: string | null
  signal_id: string | null
  created_at: string
  deadline_at: string | null
  deadline_ms: number | null
  outcome: 'signal' | 'timeout' | null
  suspended_at: string | null
  resolved_at: string | null
  first_resumed_at: string | null
  timing_known: number
}

export interface Database {
  durably_waits: WaitsTable
  durably_runs: RunsTable
  durably_run_labels: RunLabelsTable
  durably_steps: StepsTable
  durably_step_attempts: StepAttemptsTable
  durably_logs: LogsTable
  durably_schema_versions: SchemaVersionsTable
}
