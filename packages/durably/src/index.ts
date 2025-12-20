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
  LogWriteEvent,
  RunCompleteEvent,
  RunFailEvent,
  RunStartEvent,
  StepCompleteEvent,
  StepFailEvent,
  StepStartEvent,
} from './events'

// Job types
export type { JobContext, JobHandle } from './job'

// Schema types (for advanced users)
export type {
  Database,
  LogsTable,
  RunsTable,
  SchemaVersionsTable,
  StepsTable,
} from './schema'
