# Implementation Plan: coalesce trigger (#143)

RFC: `docs/rfcs/coalesce-trigger/README.md`

実装完了後にこのファイルは削除する。

---

## Step 1: Schema — partial unique index

- `packages/durably/src/migrations.ts` の v1 migration に partial unique index を追加
- `CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency ON durably_runs (job_name, concurrency_key) WHERE status = 'pending' AND concurrency_key IS NOT NULL`
- `LATEST_SCHEMA_VERSION` は `1` のまま（upflow は DB 再作成前提）

## Step 2: Types — Disposition, TriggerResult, TriggerOptions

- `packages/durably/src/types.ts` に `Disposition`, `TriggerResult` 型を追加
- `TriggerOptions` に `coalesce?: 'skip'` を追加
- `index.ts` から export

## Step 3: Events — run:coalesced

- `packages/durably/src/events.ts` に `RunCoalescedEvent` を追加
- `DurablyEventMap` に追加

## Step 4: Storage — enqueue() の disposition 対応

- `enqueue()` の返り値を `{ run, disposition }` に変更
- `parseUniqueViolation()` を実装（PostgreSQL: constraint name、SQLite: column names）
- INSERT-first, catch conflict パターン
- PostgreSQL 用の SAVEPOINT ラッピング
- coalesce: 'skip' 時の fallback SELECT + retry ロジック
- idempotency の double-check（catch block で常に idempotency を先に確認）
- `_enqueueInTx(trx, input)` に内部リファクタ（Step 6 の batchTrigger 用）

## Step 5: Storage — releaseExpiredLeases() の 2-phase 対応

- Phase 1: pending replacement がある expired lease を failed に
- Phase 2: 残りを per-row SAVEPOINT で pending に戻す（concurrent trigger との race 対応）

## Step 6: Job — trigger(), batchTrigger(), retrigger() の更新

- `trigger()`: coalesce バリデーション + `TriggerResult` 返却 + event emit 分岐
- `batchTrigger()`: sequential enqueue（`_enqueueInTx` 使用）、per-item disposition
- `retrigger()`: `TriggerResult` with `disposition: 'created'`
- `triggerAndWait()`: disposition を result に含める
- idempotent 時の `run:trigger` emit を停止（behavior change）

## Step 7: HTTP handler — server.ts

- `TriggerRequest` に `coalesce` 追加
- `TriggerResponse` に `disposition` 追加

## Step 8: durably-react の更新

- `types.ts`: `DurablyEvent` union に `run:coalesced` 追加
- `use-runs.ts`: `run:coalesced` でリフレッシュ
- `use-job.ts` / `use-job-subscription.ts`: followLatest に `run:coalesced` 追加

## Step 9: Tests

- `packages/durably/tests/shared/coalesce.shared.ts` を新規作成
- RFC の 28 テストケースを実装
- 既存テストの `trigger()` 返り値型を更新

## Step 10: Documentation

- `packages/durably/docs/llms.md` を更新
  - trigger() 返り値、coalesce オプション、ConflictError、disposition
- `pnpm --filter durably-website generate:llms` で再生成

## Step 11: Cleanup

- このファイル (`PLAN.md`) を削除
- `pnpm validate` で最終確認
