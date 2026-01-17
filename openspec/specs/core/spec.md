# Core: Step-Oriented Batch Execution Framework

## Purpose

A step-oriented batch execution framework for Node.js and browsers. Durably enables resumable batch processing with automatic step replay on failure, using SQLite for persistence.

## Requirements

### Requirement: Job Definition

The system SHALL allow jobs to be statically defined using `defineJob` function.

- Jobs MUST have name, input schema, output schema, and handler function
- Job definitions MUST be independent of durably instance
- Schemas SHALL be defined using Zod v4 for type-safe input/output

#### Scenario: Define a job with Zod schemas

- **GIVEN** input/output are defined with Zod schemas
- **WHEN** `defineJob()` is called
- **THEN** `JobDefinition` object is returned
- **AND** input/output types are inferred from Zod schemas

---

### Requirement: Job Registration

The system SHALL require jobs to be registered with durably instance for execution.

- `register` method MUST accept `JobDefinition` and return `JobHandle`
- Registering the same `JobDefinition` multiple times SHALL register only once

#### Scenario: Register a job and get handle

- **GIVEN** a `JobDefinition` created with `defineJob()`
- **WHEN** `durably.register({ job })` is called
- **THEN** object containing `JobHandle` is returned
- **AND** `trigger`, `triggerAndWait`, `getRun`, `getRuns` are available on handle

---

### Requirement: Run Trigger

Runs SHALL be created by `trigger` function and persisted as `pending` before execution.

- `trigger` MUST only create the Run without waiting for completion
- `triggerAndWait` SHALL create Run and wait for completion
- `timeout` option SHALL cause timeout error if not completed in time

#### Scenario: Trigger a job

- **WHEN** `job.trigger(payload)` is called
- **THEN** Run is created in database with `pending` status
- **AND** Run object is returned immediately

#### Scenario: Trigger and wait for completion

- **WHEN** `job.triggerAndWait(payload, { timeout: 5000 })` is called
- **THEN** waits until Run completes
- **AND** `{ id, output }` is returned after completion

#### Scenario: Timeout on triggerAndWait

- **GIVEN** job takes 10 seconds
- **WHEN** `triggerAndWait(payload, { timeout: 1000 })` is called
- **THEN** timeout error occurs after 1 second
- **AND** Run continues in background

---

### Requirement: Idempotency Key

The system SHALL prevent duplicate registrations using `idempotencyKey`.

- If same job name and `idempotencyKey` combination exists, new Run MUST NOT be created
- `idempotencyKey` SHALL have no expiration
- Deleting Run SHALL allow re-registration with same key

#### Scenario: Duplicate trigger with same idempotency key

- **GIVEN** Run already created with `idempotencyKey: "event-123"`
- **WHEN** `trigger` is called again with same `idempotencyKey`
- **THEN** new Run is NOT created
- **AND** existing Run is returned

---

### Requirement: Concurrency Key

The system SHALL prevent simultaneous processing of same target using `concurrencyKey`.

- If Run with same `concurrencyKey` is running, subsequent Runs MUST wait
- Run creation itself SHALL NOT be cancelled

#### Scenario: Concurrent runs with same concurrency key

- **GIVEN** Run with `concurrencyKey: "org_123"` is in `running` state
- **WHEN** new Run is triggered with same `concurrencyKey`
- **THEN** new Run is created in `pending` state
- **AND** execution waits until preceding Run completes

---

### Requirement: Batch Trigger

The system SHALL allow multiple triggers to be registered at once.

- `batchTrigger` MUST register multiple Runs in a single transaction
- Execution model SHALL NOT be affected

#### Scenario: Batch trigger multiple runs

- **WHEN** `job.batchTrigger([{ payload: p1 }, { payload: p2 }])` is called
- **THEN** 2 Runs are created in single transaction
- **AND** array of Runs is returned

---

### Requirement: Run Status

Run SHALL have `pending`, `running`, `completed`, `failed`, `cancelled` states.

- `pending`: waiting for execution
- `running`: currently executing
- `completed`: successfully completed
- `failed`: execution failed
- `cancelled`: manually cancelled

#### Scenario: Normal run completion

- **GIVEN** Run is in `pending` state
- **WHEN** Worker picks up and executes the Run
- **THEN** Run transitions `running` → `completed`

#### Scenario: Run failure

- **GIVEN** Run is in `running` state
- **WHEN** exception occurs in a step
- **THEN** Run transitions to `failed` state
- **AND** error message is recorded

---

### Requirement: Step Execution

Step names MUST be unique within a Run.

- Successful steps SHALL be automatically skipped on re-execution
- Saved return values MUST be returned

#### Scenario: Step completes successfully

- **WHEN** `step.run("fetch-users", fn)` is called
- **THEN** `fn` is executed
- **AND** result is saved to database

#### Scenario: Step replay on resume

- **GIVEN** `step.run("fetch-users", fn)` was previously completed
- **WHEN** Run resumes and reaches same step
- **THEN** `fn` is NOT executed
- **AND** saved result is returned

---

### Requirement: Run Retry

The system SHALL allow re-execution of failed Runs.

- `retry` MUST reset `failed` Run to `pending` state
- Successful steps SHALL be skipped

#### Scenario: Retry a failed run

- **GIVEN** Run is in `failed` state
- **WHEN** `durably.retry(runId)` is called
- **THEN** Run transitions to `pending` state
- **AND** Worker picks up and executes again

---

### Requirement: Run Cancel

The system SHALL allow cancellation of running or pending Runs.

- `cancel` MUST transition `pending` or `running` Run to `cancelled`
- Cancelling `running` Run SHALL allow current step to complete

#### Scenario: Cancel a pending run

- **GIVEN** Run is in `pending` state
- **WHEN** `durably.cancel(runId)` is called
- **THEN** Run transitions to `cancelled` state

---

### Requirement: Run Delete

The system SHALL allow deletion of completed, failed, or cancelled Runs.

- Run and related steps, logs MUST be deleted
- `pending` or `running` Runs MUST NOT be deletable
- After deletion, new Run MAY be created with same `idempotencyKey`

#### Scenario: Delete a completed run

- **GIVEN** Run is in `completed` state
- **WHEN** `durably.deleteRun(runId)` is called
- **THEN** Run and related data are deleted

---

### Requirement: Run Query

The system SHALL provide API to check Run status.

- `JobHandle.getRun(id)` MUST return type-safe output
- `JobHandle.getRuns(filter)` MUST return Runs for this job
- `durably.getRun(id)` SHALL return output as `unknown` type
- `durably.getRuns(filter)` SHALL query across all jobs

#### Scenario: Get runs with filter

- **WHEN** `durably.getRuns({ status: 'failed', limit: 10 })` is called
- **THEN** up to 10 failed Runs are returned
- **AND** sorted by `created_at` descending

---

### Requirement: Run Subscription

The system SHALL allow real-time subscription to Run execution.

- `subscribe` MUST return `ReadableStream<DurablyEvent>`
- Stream SHALL auto-close on `run:complete` or `run:fail`

#### Scenario: Subscribe to run events

- **GIVEN** Run is executing
- **WHEN** `durably.subscribe(runId)` is called
- **THEN** event stream is returned
- **AND** `step:start`, `step:complete` events are delivered

---

### Requirement: Worker

Worker SHALL be started by `start` function and execute `pending` Runs sequentially.

- Worker MUST operate on polling basis (default 1000ms)
- Worker MUST process one Run at a time
- Heartbeat MUST be updated periodically for crash detection

#### Scenario: Worker processes pending run

- **GIVEN** Run is in `pending` state
- **WHEN** Worker's polling cycle occurs
- **THEN** Run transitions to `running` and executes

#### Scenario: Stale run recovery

- **GIVEN** Run is `running` with stale heartbeat
- **WHEN** heartbeat exceeds threshold (default 30 seconds)
- **THEN** Run is reset to `pending`
- **AND** re-executed on next poll

---

### Requirement: Event System

The system SHALL have event system to notify external consumers.

- Events MUST include: `run:trigger`, `run:start`, `run:complete`, `run:fail`, `run:cancel`, `run:retry`, `run:progress`
- Events MUST include: `step:start`, `step:complete`, `step:fail`
- Events MUST include: `log:write`, `worker:error`

#### Scenario: Listen to run events

- **WHEN** `durably.on('run:complete', handler)` is registered
- **AND** Run completes
- **THEN** `handler` is called with `{ runId, jobName, output, duration }`

---

### Requirement: Progress Tracking

The system SHALL allow job progress to be tracked externally.

- `step.progress(current, total?, message?)` MUST record progress
- `getRun` SHALL return `progress` field

#### Scenario: Report progress

- **WHEN** `step.progress(50, 100, "Processing...")` is called
- **THEN** Run's `progress` field is updated
- **AND** `run:progress` event is emitted

---

### Requirement: Structured Logging

The system SHALL allow explicit logging from within jobs.

- `step.log.info(message, data?)`, `step.log.warn(...)`, `step.log.error(...)` MUST be available
- Logs SHALL be emitted as `log:write` events

#### Scenario: Write structured log

- **WHEN** `step.log.info('fetched users', { count: 10 })` is called
- **THEN** `log:write` event is emitted
- **AND** event contains `{ level: 'info', message, data }`

---

### Requirement: Plugin System

The system SHALL provide plugin-based extensions using events.

- `durably.use(plugin)` MUST register plugins
- `withLogPersistence()` SHALL persist logs to database

#### Scenario: Enable log persistence plugin

- **WHEN** `durably.use(withLogPersistence())` is called
- **AND** `step.log.info(...)` is called
- **THEN** log is persisted to `logs` table

---

### Requirement: Database Migration

Database tables SHALL be created via `migrate` function.

- Migration MUST be idempotent (safe to call multiple times)
- Schema versioning SHALL be managed internally

#### Scenario: Run migration

- **WHEN** `await durably.migrate()` is called
- **THEN** required tables are created
- **AND** schema version is recorded

---

### Requirement: Cross-Environment Support

Same job definition code SHALL work in both Node.js and browsers.

- Node.js: Turso/libsql dialect MUST be supported
- Browser: SQLocal (SQLite WASM + OPFS) MUST be supported
- Environment differences SHALL be abstracted via dialect passed to `createDurably`

#### Scenario: Run in Node.js

- **GIVEN** durably is created with `LibsqlDialect`
- **WHEN** job is triggered
- **THEN** state is persisted to local SQLite file

#### Scenario: Run in browser

- **GIVEN** durably is created with `SQLocalKysely` dialect
- **WHEN** job is triggered
- **THEN** state is persisted to OPFS
