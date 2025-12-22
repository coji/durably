# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
