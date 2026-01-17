# Change: PostgreSQL Support

## Why

SQLite works well for single-process deployments, but production environments often require PostgreSQL for multi-worker scaling and better operational tooling. Adding PostgreSQL dialect support enables horizontal scaling with proper run claiming and concurrency key protection.

## What Changes

- Add PostgreSQL dialect support via Kysely
- Implement atomic Run claiming with `FOR UPDATE SKIP LOCKED`
- Add `durably_concurrency_locks` table for concurrency key protection
- Ensure SQLite behavior remains unchanged

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/storage.ts` - PG-specific claiming logic
  - `packages/durably/src/schema.ts` - concurrency_locks table
  - `packages/durably/src/migrations.ts` - PG migrations
  - New: `packages/durably/src/pg-storage.ts` (optional separate file)
