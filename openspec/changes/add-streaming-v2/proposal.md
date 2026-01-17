# Change: Streaming v2 - AI Agent ワークフロー拡張

## Why

AI Agent ワークフローでは、リアルタイムのトークンストリーミング、再接続のためのイベント永続化、長時間実行のチェックポイントが必要。現在の `subscribe()` はメモリ上のイベントストリーミングのみで永続化されない。

## What Changes

- `step.stream()` API: トークンレベルのストリーミング出力
- イベント永続化: 再接続サポートのため DB に保存
- `resumeFrom` オプション: `subscribe()` で見逃したイベントを再生
- `checkpoint()` API: 長時間ステップの復旧（Phase C）

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/context.ts` - `step.stream()` 追加
  - `packages/durably/src/storage.ts` - `events` テーブル操作追加
  - `packages/durably/src/durably.ts` - `subscribe()` 拡張
  - `packages/durably/src/schema.ts` - `events` テーブル定義
  - `packages/durably/src/migrations.ts` - events テーブルマイグレーション
