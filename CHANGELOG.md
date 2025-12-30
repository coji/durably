# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.6.0] - 2025-12-30

### Breaking Changes

- **`register()` API simplified**: `registerAll()` renamed to `register()`, old single-job signature removed
  - New: `const { job } = durably.register({ job: jobDef })`
  - Old (removed): `const job = durably.register(jobDef)`

### Added

#### @coji/durably-react

- `useRuns`: List and paginate job runs with filtering and real-time updates
  - Supports filtering by `jobName` and `status`
  - Built-in pagination with `nextPage`, `prevPage`, `goToPage`
  - Real-time updates via `realtime` option (default: true)
- `useJob` options:
  - `autoResume`: Automatically resume tracking pending/running jobs on mount (default: true)
  - `followLatest`: Automatically switch to tracking the latest running job (default: true)
- `createDurablyClient`: Type-safe client factory for server-connected mode
- `createJobHooks`: Per-job hook factory for server-connected mode

### Changed

- Simplified README files - detailed documentation moved to website
- Updated all examples to use new `register()` API pattern
- Added Turbo for monorepo task orchestration

### Fixed

- Type inference for `register()` return value now works correctly

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
