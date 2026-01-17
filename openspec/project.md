# Project Context

## Purpose

Durably is a step-oriented resumable batch execution framework for Node.js and browsers. It enables resumable batch processing with minimal dependencies using only SQLite for persistence. The same job definition code runs in both environments.

**Target Users**: Individual developers and small teams building AI agents, workflow automation, and batch processing systems.

**Core Value Proposition**:
- Resume interrupted jobs automatically
- Persist step results for debugging and replay
- Single SQLite file for all state (no Redis, no Postgres required)
- Works in browsers (WASM + OPFS) and Node.js

## Tech Stack

- **Language**: TypeScript (ESM-only, strict mode)
- **Package Manager**: pnpm (v10+) with workspaces
- **Database**: SQLite via Kysely ORM
  - Node.js: Turso/libsql
  - Browser: SQLocal (SQLite WASM with OPFS backend)
- **Schema Validation**: Zod v4
- **Testing**: Vitest (node, browser, react configs)
- **Linting**: Biome
- **Formatting**: Prettier

## Project Conventions

### Code Style

- **Formatter**: Prettier (auto-runs via hooks)
- **Linter**: Biome
- **Type Checking**: TypeScript strict mode
- **Naming**:
  - Files: kebab-case (`job-context.ts`)
  - Classes/Types: PascalCase (`Durably`, `JobContext`)
  - Functions/Variables: camelCase (`createDurably`, `defineJob`)
  - Constants: UPPER_SNAKE_CASE for true constants

### Architecture Patterns

- **Dialect Injection**: Kysely dialect passed to `createDurably()` to abstract SQLite implementations
- **Event System**: Extensibility via event emitter (`run:start`, `run:complete`, `run:fail`, `step:*`, `log:write`)
- **Single-threaded Execution**: No parallel run processing in minimal config
- **No Automatic Retry**: Failures are immediate and explicit (`retry()` API for manual retry)
- **Step Idempotency**: Completed steps return cached output on replay

### Testing Strategy

- Shared test suites in `tests/shared/*.shared.ts`
- Environment-specific runners in `tests/node/` and `tests/browser/`
- Use `vi.waitFor()` for async assertions
- Each test cleans up with `afterEach` (stop worker, destroy db)
- Playwright for browser environment tests

### Git Workflow

- Main branch: `main`
- Feature branches: `feature/<name>`
- Conventional commits preferred
- PR-based workflow

## Domain Context

### Core Concepts

- **Job**: Defined via `defineJob()` and registered with `durably.register()`, receives a step context and payload
- **Step**: Created via `step.run()`, each step's success state and return value is persisted
- **Run**: A job execution instance, created via `trigger()`, always persisted as `pending` before execution
- **Worker**: Polls for pending runs and executes them sequentially

### Run Status Flow

```text
pending -> running -> completed
              |          |
              +-> failed-+
              |
              +-> cancelled
```

### Database Schema

Four tables: `durably_runs`, `durably_steps`, `durably_logs`, `durably_schema_versions`

- Runs: `status`, `idempotency_key`, `concurrency_key`, `heartbeat_at`
- Steps: `status` (completed/failed), `output` (JSON), indexed by `run_id` and `index`

## Important Constraints

- **ESM-only**: CommonJS is not supported
- **SQLite-first**: No Redis or external queue dependencies
- **Browser Constraints**:
  - Single tab usage assumed (OPFS exclusivity)
  - Requires Secure Context (HTTPS/localhost) for OPFS
  - Background tab interruptions handled via heartbeat recovery

## External Dependencies

- **Kysely**: SQL query builder (dialect abstraction)
- **libsql**: SQLite driver for Node.js (Turso compatible)
- **SQLocal**: SQLite WASM with OPFS for browsers
- **Zod**: Schema validation for job inputs/outputs

## Monorepo Structure

```text
/
├── packages/durably/       # Main library (@coji/durably)
├── packages/durably-react/ # React hooks (@coji/durably-react)
├── examples/               # Example applications
│   ├── node/
│   ├── browser/
│   └── react/
├── docs/                   # Specification documents
└── website/                # Documentation website
```

## Development Commands

```bash
pnpm validate      # Format check, lint, typecheck, tests
pnpm test          # Run all tests
pnpm format        # Fix formatting
pnpm lint:fix      # Fix lint issues
```
