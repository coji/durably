import { type JsonValue, serializeJsonValue } from './attempts'
import type { Database } from './schema'

export type DurableWaitOutcome = 'signal' | 'timeout'
export type DurableWaitResult =
  | { type: 'signal'; payload: JsonValue }
  | { type: 'timeout' }

export interface DurableWait {
  id: string
  runId: string
  name: string
  metadata: JsonValue | null
  status: 'pending' | 'resolved' | 'cancelled' | 'closed'
  payload: JsonValue | null
  signalId: string | null
  createdAt: string
  deadlineAt: string | null
  outcome: DurableWaitOutcome | null
  suspendedAt: string | null
  resolvedAt: string | null
  firstResumedAt: string | null
  /** Time spent suspended before an external result was finalized. */
  inputWaitMs: number | null
  /** Time from finalization to the first resumed lease. */
  executionSlotWaitMs: number | null
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
  const inputWaitMs =
    row.outcome === null || row.timing_known !== 1 || row.resolved_at === null
      ? null
      : row.suspended_at === null
        ? 0
        : Math.max(
            0,
            Date.parse(row.resolved_at) - Date.parse(row.suspended_at),
          )
  const executionSlotWaitMs =
    row.outcome === null || row.timing_known !== 1 || row.resolved_at === null
      ? null
      : row.suspended_at === null
        ? 0
        : row.first_resumed_at === null
          ? null
          : Math.max(
              0,
              Date.parse(row.first_resumed_at) -
                Math.max(
                  Date.parse(row.resolved_at),
                  Date.parse(row.suspended_at),
                ),
            )
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    status: row.status,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    signalId: row.signal_id,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    outcome: row.outcome,
    suspendedAt: row.suspended_at,
    resolvedAt: row.resolved_at,
    firstResumedAt: row.first_resumed_at,
    inputWaitMs,
    executionSlotWaitMs,
  }
}
