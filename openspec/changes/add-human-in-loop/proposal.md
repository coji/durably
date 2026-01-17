# Change: Human-in-the-Loop (HITL) 対応

## Why

AI エージェントワークフローにおいて、自動処理の途中で人間の承認・修正・却下を挟む必要がある。現状の durably では Run を一時停止して外部からの入力を待つ機能がない。

## What Changes

- `ctx.human()` API の追加: Step 内で人間の承認を要求できる
- `waiting_human` ステータスの追加: Run が人間の入力待ち状態を表現
- `durably.resume(token, payload)` API の追加: 外部から Run を再開
- HTTP API 拡張: `POST /resume` エンドポイント
- DB スキーマ拡張: `wait_*` カラムの追加

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/context.ts` - `ctx.human()` 追加
  - `packages/durably/src/durably.ts` - `resume()` 追加
  - `packages/durably/src/schema.ts` - `waiting_human` ステータス追加
  - `packages/durably/src/storage.ts` - wait 関連フィールド追加
  - `packages/durably/src/server.ts` - `POST /resume` ハンドラ追加
  - `packages/durably/src/worker.ts` - `WaitHumanSignal` ハンドリング
  - `packages/durably/src/migrations.ts` - version 2 マイグレーション
