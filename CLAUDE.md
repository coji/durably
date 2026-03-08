# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Durably is a step-oriented batch execution framework for Node.js and browsers. It enables resumable batch processing with minimal dependencies using only SQLite for persistence. The same job definition code runs in both environments - Node.js uses better-sqlite3/libsql, browsers use SQLite WASM with OPFS backend.

## Documentation

- `packages/durably/docs/llms.md` - LLM/AI agent documentation (bundled in npm package)

### LLM Documentation Maintenance

When API changes are made, update `packages/durably/docs/llms.md` to keep it in sync. This file is:

- Bundled in the npm package for coding agents to read from `node_modules`
- Symlinked to `website/public/llms.txt` for web access

## Core Concepts

- **Job**: Defined via `defineJob()` and registered via `jobs` option (or `.register()`), receives a step context and payload
- **Step**: Created via `step.run()`, each step's success state and return value is persisted (cleaned up on terminal state by default, see `cleanupSteps`)
- **Run**: A job execution instance, created via `trigger()`, always persisted as `pending` before execution
- **Worker**: Polls for pending runs and executes them sequentially

## Key Design Decisions

- **ESM-only**: This library is ESM-only. CommonJS is not supported. Always use top-level `await` for async initialization (e.g., `await durably.migrate()`). Do not wrap in async IIFE or Promise chains.
- Single-threaded execution, no parallel run processing in minimal config
- No automatic retry - failures are immediate and explicit (`retrigger()` creates a fresh run with a new ID and returns it)
- Dialect injection pattern - Kysely dialect passed to `createDurably()` to abstract SQLite implementations
- Event system for extensibility (`run:leased`, `run:complete`, `run:fail`, `step:*`, `log:write`)

## Database Schema

Four tables: `durably_runs`, `durably_steps`, `durably_logs`, `durably_schema_versions`. Key fields:

- Runs have: `status` (pending/leased/completed/failed/cancelled), `idempotency_key`, `concurrency_key`, `lease_owner`, `lease_expires_at`
- Steps have: `status` (completed/failed), `output` (JSON), indexed by `run_id` and `index`

## Configuration Defaults

- `pollingIntervalMs`: 1000ms
- `leaseRenewIntervalMs`: 5000ms
- `leaseMs`: 30000ms (lease duration; expired leases are reclaimed)
- `preserveSteps`: false (deletes step output data when runs reach terminal state)

## Browser Constraints (by design)

- Single tab usage assumed (OPFS exclusivity)
- Background tab interruptions handled via heartbeat recovery
- Requires Secure Context (HTTPS/localhost) for OPFS

## Git Workflow

- **main ブランチへの直接コミット・push は禁止。** 必ず feature ブランチを切って PR を作成すること。
- リリース準備（version bump, changelog）も PR 経由で行う。

## Development Commands

```bash
pnpm validate      # Format check, lint, typecheck, tests
pnpm test          # Run all tests
pnpm format        # Fix formatting
pnpm lint:fix      # Fix lint issues
```

## Skills

- **release-check** - Pre-release integrity check for API changes and spec updates (`.claude/skills/release-check/`)
- **doc-check** - Documentation update checklist after API changes (`.claude/skills/doc-check/`)
