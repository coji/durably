import { type JsonValue, serializeJsonValue } from './attempts'
import type { Database } from './schema'

export interface DurableWait {
  id: string
  runId: string
  name: string
  metadata: JsonValue | null
  status: 'pending' | 'resolved' | 'cancelled' | 'closed'
  payload: JsonValue | null
  signalId: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface WaitHandle {
  id: string
}
export interface SignalOptions {
  signalId: string
}

/** Validate before sorting; never invoke user getters or toJSON hooks. */
export function canonicalWaitJson(value: unknown): string {
  const snapshot = JSON.parse(serializeJsonValue(value)) as JsonValue
  function sort(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sort)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, JsonValue> = Object.create(null)
      for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ))
        result[key] = sort(item)
      return result
    }
    return value
  }
  return JSON.stringify(sort(snapshot))
}

export function rowToWait(row: Database['durably_waits']): DurableWait {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    status: row.status,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    signalId: row.signal_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}
