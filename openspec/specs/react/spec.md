# React: Durably React Bindings

## Purpose

React bindings for Durably, supporting both browser-complete mode and server-connected client mode.

## Requirements

### Requirement: Durably Provider Context

The system SHALL provide a React context for a Durably instance.

- The system MUST provide `DurablyProvider` that accepts `durably: Durably | Promise<Durably>`
- The provider MUST expose `useDurably()` to read the instance
- `useDurably()` MUST throw when used outside `DurablyProvider`
- When `fallback` is provided, the provider MUST wrap children in a Suspense boundary

#### Scenario: Resolve provider from Promise

- **GIVEN** `durably` is a Promise
- **WHEN** `DurablyProvider` renders with `fallback`
- **THEN** the fallback is shown until the Promise resolves
- **AND** `useDurably()` returns the resolved instance

---

### Requirement: Browser Mode Job Hook

The system SHALL provide a browser-complete job hook.

- The system MUST provide `useJob(jobDefinition, options?)`
- The hook MUST return `trigger`, `triggerAndWait`, `status`, `output`, `error`, `logs`, and `progress`
- The hook MUST return state booleans `isRunning`, `isPending`, `isCompleted`, `isFailed`, `isCancelled`
- The hook MUST return `currentRunId` and `reset`
- The hook MUST accept `initialRunId`, `autoResume`, and `followLatest`

#### Scenario: Trigger and observe job

- **GIVEN** a registered job definition
- **WHEN** `useJob(jobDefinition)` triggers a run
- **THEN** `currentRunId` is set and `status` updates as the run progresses

---

### Requirement: Browser Mode Run Hooks

The system SHALL provide run-focused hooks in browser mode.

- The system MUST provide `useJobRun({ runId })` for run status/output
- The system MUST provide `useJobLogs({ runId, maxLogs? })` for log streams
- The system MUST provide `useRuns(options?)` for listing runs

#### Scenario: Subscribe to an existing run

- **GIVEN** a valid `runId`
- **WHEN** `useJobRun({ runId })` is called
- **THEN** the hook returns `status`, `output`, and `progress` for that run

---

### Requirement: Client Mode Job Hook

The system SHALL provide a server-connected job hook.

- The system MUST provide `useJob({ api, jobName, options? })`
- The hook MUST return `trigger`, `triggerAndWait`, `status`, `output`, `error`, `logs`, and `progress`
- The hook MUST return state booleans `isRunning`, `isPending`, `isCompleted`, `isFailed`, and `isCancelled`
- The hook MUST return `currentRunId` and `reset`
- The hook MUST use HTTP/SSE to trigger and subscribe

#### Scenario: Trigger via API

- **GIVEN** `api` and `jobName`
- **WHEN** `useJob({ api, jobName })` triggers a run
- **THEN** the hook receives updates via SSE subscription

---

### Requirement: Client Mode Run Hooks

The system SHALL provide server-connected run hooks.

- The system MUST provide `useJobRun({ api, runId })`
- The system MUST provide `useJobLogs({ api, runId, maxLogs? })`
- The system MUST provide `useRuns({ api, options? })`
- The system MUST provide `useRunActions({ api })` with `retry`, `cancel`, `deleteRun`, `getRun`, and `getSteps`

#### Scenario: Fetch run actions

- **GIVEN** `useRunActions({ api })`
- **WHEN** `retry(runId)` is called
- **THEN** the run is retried via the API

---

### Requirement: Typed Client Factories

The system SHALL provide typed helper factories for client mode.

- The system MUST provide `createDurablyClient({ api })`
- The system MUST provide `createJobHooks({ api, jobName })`
- The factories MUST return `useJob`, `useRun`, and `useLogs` hooks

#### Scenario: Create typed hooks for a job

- **GIVEN** a job type and API base
- **WHEN** `createJobHooks({ api, jobName })` is called
- **THEN** the returned hooks are type-safe for that job
