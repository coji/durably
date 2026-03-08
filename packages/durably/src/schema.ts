/**
 * Database schema types for Durably
 */

export interface RunsTable {
  id: string
  job_name: string
  input: string // JSON
  status: 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'
  idempotency_key: string | null
  concurrency_key: string | null
  current_step_index: number
  progress: string | null // JSON: { current, total, message }
  output: string | null // JSON
  error: string | null
  labels: string // JSON: Record<string, string>
  lease_owner: string | null
  lease_expires_at: string | null // ISO8601
  lease_generation: number
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

export interface Database {
  durably_runs: RunsTable
  durably_run_labels: RunLabelsTable
  durably_steps: StepsTable
  durably_logs: LogsTable
  durably_schema_versions: SchemaVersionsTable
}
