# Change: Streaming v2 - AI Agent Workflow Extensions

## Why

AI Agent workflows require real-time token streaming, event persistence for reconnection, and checkpointing for long-running operations. Current `subscribe()` only provides in-memory event streaming without persistence.

## What Changes

- `step.stream()` API for token-level streaming output
- Event persistence to database for reconnection support
- `resumeFrom` option for `subscribe()` to replay missed events
- `checkpoint()` API for long-running step recovery (Phase C)

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/context.ts` - `step.stream()` 追加
  - `packages/durably/src/storage.ts` - `events` テーブル操作追加
  - `packages/durably/src/durably.ts` - `subscribe()` 拡張
  - `packages/durably/src/schema.ts` - `events` テーブル定義
  - `packages/durably/src/migrations.ts` - events テーブルマイグレーション
