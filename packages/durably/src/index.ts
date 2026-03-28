/**
 * durably - Step-oriented resumable batch execution for Node.js and browsers
 */

// Core
export { createDurably } from './durably'
export type {
  AnyDurably,
  Durably,
  DurablyOptions,
  DurablyPlugin,
} from './durably'

// Job Definition
export { defineJob } from './define-job'
export type { JobDefinition, JobInput, JobOutput } from './define-job'

// Plugins
export { withLogPersistence } from './plugins/log-persistence'

// Events
export { isDomainEvent } from './events'
export type {
  DomainEvent,
  DomainEventType,
  DurablyEvent,
  ErrorHandler,
  EventType,
  LogData,
  LogWriteEvent,
  OperationalEvent,
  OperationalEventType,
  ProgressData,
  RunCancelEvent,
  RunCoalescedEvent,
  RunCompleteEvent,
  RunDeleteEvent,
  RunFailEvent,
  RunLeaseRenewedEvent,
  RunLeasedEvent,
  RunProgressEvent,
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
  Disposition,
  JobHandle,
  StepContext,
  TriggerAndWaitOptions,
  TriggerAndWaitResult,
  TriggerOptions,
  TriggerResult,
  WaitForRunOptions,
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
export { createKyselyStore, toClientRun } from './storage'
export type {
  ClientRun,
  EnqueueResult,
  Log,
  Run,
  RunFilter,
  RunStatus,
  Step,
  Store,
  UpdateRunData,
} from './storage'

// Errors
export {
  CancelledError,
  ConflictError,
  DurablyError,
  LeaseLostError,
  NotFoundError,
  ValidationError,
} from './errors'

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
