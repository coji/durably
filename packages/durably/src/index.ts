/**
 * durably - Step-oriented resumable batch execution for Node.js and browsers
 */

// Core
export { createDurably } from './durably'
export type { Durably, DurablyOptions, DurablyPlugin } from './durably'

// Job Definition
export { defineJob } from './define-job'
export type { JobDefinition, JobInput, JobOutput } from './define-job'

// Plugins
export { withLogPersistence } from './plugins/log-persistence'

// Events
export type {
  DurablyEvent,
  ErrorHandler,
  EventType,
  LogData,
  LogWriteEvent,
  ProgressData,
  RunCancelEvent,
  RunCompleteEvent,
  RunDeleteEvent,
  RunFailEvent,
  RunProgressEvent,
  RunStartEvent,
  RunTriggerEvent,
  StepCancelEvent,
  StepCompleteEvent,
  StepFailEvent,
  StepStartEvent,
  WorkerErrorEvent,
} from './events'

// Job types
export type {
  BatchTriggerInput,
  JobHandle,
  StepContext,
  TriggerAndWaitOptions,
  TriggerAndWaitResult,
  TriggerOptions,
} from './job'

// Schema types (for advanced users)
export type {
  Database,
  LogsTable,
  RunsTable,
  SchemaVersionsTable,
  StepsTable,
} from './schema'

// Storage types
export { toClientRun } from './storage'
export type { ClientRun, Log, Run, RunFilter, Step } from './storage'

// Errors
export { CancelledError } from './errors'

// Server
export { createDurablyHandler } from './server'
export type {
  AuthConfig,
  CreateDurablyHandlerOptions,
  DurablyHandler,
  RunOperation,
  RunsSubscribeFilter,
  TriggerRequest,
  TriggerResponse,
} from './server'
