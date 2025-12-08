# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Durably is a step-oriented batch execution framework for Node.js and browsers. It enables resumable batch processing with minimal dependencies using only SQLite for persistence. The same job definition code runs in both environments - Node.js uses better-sqlite3/libsql, browsers use SQLite WASM with OPFS backend.

**Current Status**: Specification phase only (see `docs/durably.md`). No implementation exists yet.

## Core Concepts

- **Job**: Defined via `defineJob()`, receives a context object and payload
- **Step**: Created via `ctx.run()`, each step's success state and return value is persisted
- **Run**: A job execution instance, created via `trigger()`, always persisted as `pending` before execution
- **Worker**: Polls for pending runs and executes them sequentially

## Key Design Decisions

- Single-threaded execution, no parallel run processing in minimal config
- No automatic retry - failures are immediate and explicit (`retry()` API for manual retry)
- Dialect injection pattern - Kysely dialect passed to `createClient()` to abstract SQLite implementations
- Event system for extensibility (`run:start`, `run:complete`, `run:fail`, `step:*`, `log:write`)
- Plugin architecture (`client.use()`) for optional features like log persistence

## Database Schema

Four tables: `runs`, `steps`, `logs`, `schema_versions`. Key fields:
- Runs have: `status` (pending/running/completed/failed), `idempotency_key`, `concurrency_key`, `heartbeat_at`
- Steps have: `status` (completed/failed), `output` (JSON), indexed by `run_id` and `index`

## Configuration Defaults

- `pollingInterval`: 1000ms
- `heartbeatInterval`: 5000ms
- `staleThreshold`: 30000ms (for detecting abandoned runs)

## Browser Constraints (by design)

- Single tab usage assumed (OPFS exclusivity)
- Background tab interruptions handled via heartbeat recovery
- Requires Secure Context (HTTPS/localhost) for OPFS
