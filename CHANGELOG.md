# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.1] - 2026-01-03

### Fixed

#### @coji/durably

- Run ordering now deterministic when multiple runs are created within the same millisecond
  - Added ULID-based secondary sort key to `getNextPendingRun()`

### Changed

#### @coji/durably

- Internal code organization improvements (no API changes)
  - Extracted SSE utilities to `sse.ts`
  - Extracted HTTP response helpers to `http.ts`
  - Centralized error handling in `errors.ts`

## [0.6.0] - 2026-01-02

### Breaking Changes

#### @coji/durably

- **`register()` API simplified**: `registerAll()` renamed to `register()`, old single-job signature removed
  ```diff
  - const job = durably.register(jobDef)
  + const { job } = durably.register({ job: jobDef })
  ```

#### @coji/durably-react

- **`DurablyProvider` simplified**: Removed `autoStart`, `onReady` props and `isReady` state
  - Provider now only provides context; durably instance must be initialized before passing
  - All hooks no longer return `isReady` - always ready when durably is available
  - Migration: Call `await durably.init()` before passing to `DurablyProvider`
  ```diff
  - <DurablyProvider durably={durably} autoStart onReady={() => console.log('ready')}>
  + <DurablyProvider durably={durably}>
  ```
- **React 19 required**: `peerDependencies` now requires React 19+ (uses `React.use()` hook)

### Added

#### @coji/durably

- **`init()` method**: Combines `migrate()` and `start()` for simpler initialization
  ```ts
  const durably = createDurably({ dialect })
  await durably.init() // migrate + start in one call
  ```
- **Type-safe `durably.jobs` property**: Access registered jobs with full type inference
  ```ts
  const durably = createDurably({ dialect }).register({ processImage, syncUsers })
  await durably.jobs.processImage.trigger({ imageId: '123' }) // Type-safe
  ```
- **Retry from cancelled state**: `retry()` now works on both `failed` and `cancelled` runs
- **New events**: `run:trigger`, `run:cancel`, `run:retry` for complete run lifecycle tracking
- **`stepCount` on `Run` type**: Number of completed steps, available in `getRun()`, `getRuns()`

#### @coji/durably/server

- **New endpoints**: `GET /steps?runId=xxx`, `DELETE /run?runId=xxx`
- **SSE enhancements**: `/runs/subscribe` now streams all lifecycle events
  - Run events: `run:trigger`, `run:start`, `run:complete`, `run:fail`, `run:cancel`, `run:retry`, `run:progress`
  - Step events: `step:start`, `step:complete`, `step:fail`
  - Log events: `log:write`

#### @coji/durably-react

- **`useRuns` hook**: List and paginate runs with filtering (`jobName`, `status`) and real-time updates
  - Subscribes to step and progress events for live dashboard updates
- **`useJob` options**: `autoResume` (track pending/running jobs on mount), `followLatest` (switch to latest run)
- **`createDurablyClient`**: Type-safe client factory for server-connected mode
- **`createJobHooks`**: Per-job hook factory for server-connected mode

#### @coji/durably-react/client

- **`useRunActions` enhancements**: `deleteRun()`, `getRun()`, `getSteps()`
- **Step progress**: `stepCount` and `currentStepIndex` on `ClientRun` and `RunRecord` types
- **New type exports**: `RunRecord`, `StepRecord`

### Changed

- Simplified README files - detailed documentation moved to website
- Updated all examples to use new `register()` API pattern
- Added Turbo for monorepo task orchestration
- Unified dashboard UI across all examples

### Fixed

- Type inference for `register()` return value now works correctly
- SSE stream lifecycle properly cleaned up on client disconnect

## [0.5.0] - 2025-12-24

### Added

#### @coji/durably

- `run:progress` event: Now emitted when `step.progress()` is called
  - Enables real-time progress tracking via event subscription
  - Event payload: `{ runId, jobName, progress: { current, total?, message? } }`
- `getJob(name)`: Retrieve a registered job by name
- `subscribe(runId)`: Subscribe to run events as a ReadableStream
- `createDurablyHandler(durably)`: Create HTTP handlers for client/server architecture

#### @coji/durably-react (New Package)

- Initial release of React bindings for Durably
- **Browser-complete mode**: Run Durably entirely in the browser with SQLite WASM
  - `DurablyProvider`: React context provider for Durably instance
  - `useDurably`: Access the Durably instance directly
  - `useJob`: Trigger and monitor a job with real-time updates
  - `useJobRun`: Subscribe to an existing run by ID
  - `useJobLogs`: Subscribe to logs from a run
- **Server-connected mode**: Connect to a remote Durably server via SSE
  - `useJob`, `useJobRun`, `useJobLogs` from `@coji/durably-react/client`
  - Works with `createDurablyHandler` on the server

## [0.4.0] - 2025-12-23

### Breaking Changes

- **New API pattern**: `defineJob()` + `durably.register()` replaces `durably.defineJob()`
  - `defineJob()` is now a standalone function that creates a `JobDefinition`
  - `durably.register({ name: jobDef })` registers jobs and returns an object of `JobHandle`s
  - This enables idempotent registration (safe for React StrictMode)
  - Supports registering multiple jobs in a single call

### Migration

```diff
- import { createDurably } from '@coji/durably'
+ import { createDurably, defineJob } from '@coji/durably'

- const myJob = durably.defineJob({
-   name: 'my-job',
-   input: z.object({ id: z.string() }),
- }, async (step, payload) => {
-   // ...
- })
+ const myJobDef = defineJob({
+   name: 'my-job',
+   input: z.object({ id: z.string() }),
+   run: async (step, payload) => {
+     // ...
+   },
+ })
+ const { myJob } = durably.register({ myJob: myJobDef })
```

### Removed

- Japanese documentation (consolidated to English only for easier maintenance)

## [0.3.0] - 2025-12-22

### Added

- Bundled LLM/AI agent documentation in npm package (`docs/llms.md`)
  - Enables coding agents to read documentation directly from `node_modules`
  - Inspired by [ryoppippi's approach](https://ryoppippi.com/blog/2025-12-14-publish-docs-on-npm-ja)

## [0.2.0] - 2025-12-22

### Breaking Changes

- Renamed job handler first argument from `context` to `step` (Inngest-style API)
  - `JobContext` → `StepContext`
  - `createJobContext` → `createStepContext`
  - Handler signature: `(context, payload)` → `(step, payload)`

### Migration

```diff
- durably.defineJob({ name: 'my-job', input }, async (context, payload) => {
-   await context.run('step1', () => doSomething())
+ durably.defineJob({ name: 'my-job', input }, async (step, payload) => {
+   await step.run('step1', () => doSomething())
  })
```

## [0.1.1] - 2025-12-21

### Added

- Initial public release
- Step-oriented resumable batch execution
- SQLite persistence (Node.js and browser)
- Event system for job monitoring
- Progress tracking
- Concurrency control
