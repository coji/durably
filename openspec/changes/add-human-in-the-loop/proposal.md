# Change: Human-in-the-Loop (HITL) 再設計（シンプル版）

## Why

AI エージェントワークフローにおいて、処理の途中で人間の入力を待つ機能は必須。現状案は token/権限/HTTP の説明が複雑で、React からの利用を最短にする設計へ整理し直す必要がある。

## What Changes

- **BREAKING**: 再開に token を使わず、`runId` で再開する単純モデルに変更
- `ctx.human({ message, schema?, timeoutMs? })` API を追加（`summary` ではなく `message`）
- `waiting_human` ステータスの追加: Run が人間の入力待ち状態を表現
- `durably.resume(runId, payload)` API を追加: 外部から Run を再開
- HTTP API 追加/変更: `POST /resume` を `runId` 形式に統一
- DB スキーマ拡張: `wait_message`, `wait_schema`, `wait_deadline_at` を追加（tokenは不要）
- **Security**: 認証方式はアプリ側に委譲しつつ、`/runs` と `/resume` は必ず認可を通す前提を明記

## Impact

- Affected specs: `core`, `react`
- Affected code:
  - `packages/durably/src/context.ts` - `ctx.human()` 追加
  - `packages/durably/src/durably.ts` - `resume()` 追加
  - `packages/durably/src/schema.ts` - `waiting_human` ステータス追加
  - `packages/durably/src/storage.ts` - wait 関連フィールド追加
  - `packages/durably/src/server.ts` - `POST /resume` ハンドラ追加
  - `packages/durably/src/worker.ts` - `WaitHumanSignal` ハンドリング
  - `packages/durably/src/migrations.ts` - version 2 マイグレーション
  - `packages/durably-react/*` - HITL React フックと型の更新
  - OpenSpec `specs/` および `changes/` の仕様更新
