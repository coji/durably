/**
 * durably - Step-oriented resumable batch execution for Node.js and browsers
 */

// Core
export { createDurably } from './durably'
export type { Durably, DurablyOptions, DurablyPlugin } from './durably'

// Job Definition
export { defineJob } from './define-job'
export type { JobDefinition } from './define-job'

// Plugins
export { withLogPersistence } from './plugins/log-persistence'

// Events
export type {
  DurablyEvent,
  ErrorHandler,
  EventType,
  LogWriteEvent,
  RunCompleteEvent,
  RunFailEvent,
  RunProgressEvent,
  RunStartEvent,
  StepCompleteEvent,
  StepFailEvent,
  StepStartEvent,
  WorkerErrorEvent,
} from './events'

// Job types
export type { JobHandle, StepContext, TriggerAndWaitResult } from './job'

// Schema types (for advanced users)
export type {
  Database,
  LogsTable,
  RunsTable,
  SchemaVersionsTable,
  StepsTable,
} from './schema'

// Storage types
export type { Log, Run, RunFilter, Step } from './storage'

// Errors
export { CancelledError } from './errors'

// Server
export { createDurablyHandler } from './server'
export type { DurablyHandler, TriggerRequest, TriggerResponse } from './server'
