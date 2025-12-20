/**
 * durably - Step-oriented resumable batch execution for Node.js and browsers
 */

// Core
export { createDurably } from './durably'
export type { Durably, DurablyOptions, DurablyPlugin } from './durably'

// Plugins
export { withLogPersistence } from './plugins/log-persistence'

// Events
export type {
  DurablyEvent,
  EventType,
  RunStartEvent,
  RunCompleteEvent,
  RunFailEvent,
  StepStartEvent,
  StepCompleteEvent,
  StepFailEvent,
  LogWriteEvent,
} from './events'

// Schema types (for advanced users)
export type { Database, RunsTable, StepsTable, LogsTable, SchemaVersionsTable } from './schema'
