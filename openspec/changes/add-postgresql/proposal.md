# Change: PostgreSQL サポート

## Why

SQLite は単一プロセスのデプロイには適しているが、本番環境ではマルチワーカースケーリングと運用ツーリングのために PostgreSQL が必要になることが多い。PostgreSQL dialect サポートを追加することで、適切な Run claiming と concurrency key 保護による水平スケーリングが可能になる。

## What Changes

- Kysely 経由で PostgreSQL dialect サポートを追加
- `FOR UPDATE SKIP LOCKED` でアトミックな Run claiming を実装
- concurrency key 保護のための `durably_concurrency_locks` テーブルを追加
- SQLite の動作は変更なし

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/storage.ts` - PG 固有の claiming ロジック
  - `packages/durably/src/schema.ts` - concurrency_locks テーブル
  - `packages/durably/src/migrations.ts` - PG マイグレーション
  - 新規: `packages/durably/src/pg-storage.ts`（オプション、別ファイル）
