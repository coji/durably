<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Durably is a step-oriented batch execution framework for Node.js and browsers. It enables resumable batch processing with minimal dependencies using only SQLite for persistence. The same job definition code runs in both environments - Node.js uses better-sqlite3/libsql, browsers use SQLite WASM with OPFS backend.

## Documentation

- `docs/spec.md` - Core specification
- `docs/spec-streaming.md` - Streaming extension for AI Agent workflows
- `packages/durably/docs/llms.md` - LLM/AI agent documentation (bundled in npm package)

### LLM Documentation Maintenance

When API changes are made, update `packages/durably/docs/llms.md` to keep it in sync. This file is:
- Bundled in the npm package for coding agents to read from `node_modules`
- Symlinked to `website/public/llms.txt` for web access

## Core Concepts

- **Job**: Defined via `defineJob()` and registered with `durably.register()`, receives a step context and payload
- **Step**: Created via `step.run()`, each step's success state and return value is persisted
- **Run**: A job execution instance, created via `trigger()`, always persisted as `pending` before execution
- **Worker**: Polls for pending runs and executes them sequentially

## Key Design Decisions

- **ESM-only**: This library is ESM-only. CommonJS is not supported. Always use top-level `await` for async initialization (e.g., `await durably.migrate()`). Do not wrap in async IIFE or Promise chains.
- Single-threaded execution, no parallel run processing in minimal config
- No automatic retry - failures are immediate and explicit (`retry()` API for manual retry)
- Dialect injection pattern - Kysely dialect passed to `createDurably()` to abstract SQLite implementations
- Event system for extensibility (`run:start`, `run:complete`, `run:fail`, `step:*`, `log:write`)

## Database Schema

Four tables: `durably_runs`, `durably_steps`, `durably_logs`, `durably_schema_versions`. Key fields:

- Runs have: `status` (pending/running/completed/failed/cancelled), `idempotency_key`, `concurrency_key`, `heartbeat_at`
- Steps have: `status` (completed/failed), `output` (JSON), indexed by `run_id` and `index`

## Configuration Defaults

- `pollingInterval`: 1000ms
- `heartbeatInterval`: 5000ms
- `staleThreshold`: 30000ms (for detecting abandoned runs)

## Browser Constraints (by design)

- Single tab usage assumed (OPFS exclusivity)
- Background tab interruptions handled via heartbeat recovery
- Requires Secure Context (HTTPS/localhost) for OPFS

## Development Commands

```bash
pnpm validate      # Format check, lint, typecheck, tests
pnpm test          # Run all tests
pnpm format        # Fix formatting
pnpm lint:fix      # Fix lint issues
```
