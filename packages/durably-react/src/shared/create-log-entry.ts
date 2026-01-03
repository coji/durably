import type { LogEntry } from '../types'

export interface CreateLogEntryParams {
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
}

/**
 * Creates a LogEntry with auto-generated id and timestamp.
 * Extracted to eliminate duplication between subscription hooks.
 */
export function createLogEntry(params: CreateLogEntryParams): LogEntry {
  return {
    id: crypto.randomUUID(),
    runId: params.runId,
    stepName: params.stepName,
    level: params.level,
    message: params.message,
    data: params.data,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Appends a log entry to the array, respecting maxLogs limit.
 */
export function appendLog(
  logs: LogEntry[],
  newLog: LogEntry,
  maxLogs: number,
): LogEntry[] {
  const newLogs = [...logs, newLog]
  if (maxLogs > 0 && newLogs.length > maxLogs) {
    return newLogs.slice(-maxLogs)
  }
  return newLogs
}
