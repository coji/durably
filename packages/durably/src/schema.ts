/**
 * Database schema types for Durably
 */

export interface RunsTable {
  id: string
  job_name: string
  payload: string // JSON
  status: 'pending' | 'running' | 'completed' | 'failed'
  idempotency_key: string | null
  concurrency_key: string | null
  current_step_index: number
  progress: string | null // JSON: { current, total, message }
  output: string | null // JSON
  error: string | null
  heartbeat_at: string // ISO8601
  created_at: string // ISO8601
  updated_at: string // ISO8601
}

export interface StepsTable {
  id: string
  run_id: string
  name: string
  index: number
  status: 'completed' | 'failed'
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

export interface SchemaVersionsTable {
  version: number
  applied_at: string // ISO8601
}

export interface Database {
  runs: RunsTable
  steps: StepsTable
  logs: LogsTable
  schema_versions: SchemaVersionsTable
}
