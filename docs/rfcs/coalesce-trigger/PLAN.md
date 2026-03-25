# Implementation Plan: coalesce trigger (#143)

RFC: `docs/rfcs/coalesce-trigger/README.md`

実装完了後にこのファイルは削除する。
各ステップは独立してコミットし、`pnpm validate` が通る状態を維持する。

---

## Step 1: Types — Disposition, TriggerResult, TriggerOptions, Events ✅

完了済み（commit `29b3c33`）

- `job.ts`: `Disposition` 型、`TriggerResult` 型、`TriggerOptions.coalesce` 追加
- `events.ts`: `RunCoalescedEvent` 追加、`DurablyEvent` / `AnyEventInput` に追加
- `server.ts`: `TriggerRequest.coalesce` 追加
- `index.ts`: export 追加

---

## Step 2: Schema — partial unique index

migration に partial unique index を追加する。

### 変更ファイル

- `packages/durably/src/migrations.ts`
  - v1 migration の末尾に追加:
    `CREATE UNIQUE INDEX idx_durably_runs_pending_concurrency ON durably_runs (job_name, concurrency_key) WHERE status = 'pending' AND concurrency_key IS NOT NULL`
  - `LATEST_SCHEMA_VERSION` は `1` のまま

### 完了条件

- `pnpm validate` が通る
- テストが通る（既存テストで同一 concurrencyKey の pending が複数作られるケースがないこと）

---

## Step 3: Storage — enqueue() に disposition を導入

`enqueue()` の返り値を `{ run, disposition }` に変更。`Store` interface、実装、全呼び出し元を一括更新。

### 変更ファイル

- `packages/durably/src/storage.ts`
  - `Store.enqueue()` の返り値型: `Promise<Run>` → `Promise<{ run: Run; disposition: Disposition }>`
  - `Store.enqueueMany()` の返り値型: `Promise<Run[]>` → `Promise<{ run: Run; disposition: Disposition }[]>`
  - `CreateRunInput` に `coalesce?: 'skip'` を追加
  - 実装: 既存の INSERT ロジックに disposition `'created'` / `'idempotent'` を付与して返す（この時点では conflict handling はまだ入れない）
- `packages/durably/src/job.ts`
  - `trigger()`: `storage.enqueue()` の返り値を destructure、disposition に基づく event emit 分岐を実装。返り値を `TriggerResult` に変更
  - `triggerAndWait()`: `trigger()` が返す disposition を result に含める
  - `batchTrigger()`: `storage.enqueueMany()` の返り値を destructure、per-item disposition を付与して返す
  - `JobHandle` の型シグネチャを更新（`trigger` → `TriggerResult`, `batchTrigger` → `TriggerResult[]`）
- `packages/durably/src/durably.ts`
  - `retrigger()`: `storage.enqueue()` の返り値を destructure、`disposition: 'created'` を付与して返す。返り値型を `TriggerResult` に
- `packages/durably/src/server.ts`
  - trigger handler: `coalesce` を request から `storage.enqueue()` に渡す、`disposition` を response に含める
- 既存テストファイル
  - `trigger()` の返り値を使っている箇所の型を更新

### 完了条件

- `pnpm validate` が通る
- `trigger()` が `TriggerResult` を返す（`run.disposition === 'created'` が確認できる）
- `triggerAndWait()` が `{ id, output, disposition }` を返す
- idempotencyKey hit 時に `disposition === 'idempotent'` が返り、`run:trigger` が emit されない
- 通常の trigger で `disposition === 'created'` が返り、`run:trigger` が emit される

---

## Step 4: Storage — coalesce conflict handling

`enqueue()` に INSERT conflict の catch + coalesce ロジックを追加する。RFC Step 2-3 参照。

### 変更ファイル

- `packages/durably/src/storage.ts`
  - `parseUniqueViolation()` を実装
    - PostgreSQL: error object の constraint name で判別
    - SQLite/libsql: error message の column names で判別
  - `enqueue()` の INSERT を SAVEPOINT でラップ（PostgreSQL 対応）
  - catch block: idempotency の double-check → concurrency conflict 判定
  - `coalesce: 'skip'` 時: fallback SELECT（pending only）→ retry INSERT 1回 → last-chance SELECT
  - coalesce なし: `ConflictError` を throw
  - `_enqueueInTx(trx, input)` への内部リファクタ
  - `enqueueMany()` を `_enqueueInTx` ベースの sequential enqueue に変更
- `packages/durably/src/job.ts`
  - `trigger()`: coalesce バリデーション追加（`coalesce` without `concurrencyKey` → `ValidationError`、invalid value → `ValidationError`）
  - `batchTrigger()`: per-item coalesce バリデーション追加
  - `trigger()`: `disposition === 'coalesced'` 時に `run:coalesced` event を emit

### 完了条件

- `pnpm validate` が通る
- 同一 concurrencyKey で 2 回 trigger → `ConflictError`
- 同一 concurrencyKey + `coalesce: 'skip'` で 2 回 trigger → 2 回目は既存 run を返す（`disposition === 'coalesced'`）
- `coalesce` without `concurrencyKey` → `ValidationError`
- `coalesce: 'invalid'` → `ValidationError`
- `run:coalesced` event が emit される（`skippedInput`, `skippedLabels` 付き）

---

## Step 5: Storage — releaseExpiredLeases() の 2-phase 対応

Step 2 の partial unique index により、expired lease を pending に戻す際に conflict が起きうる。RFC「Interaction with releaseExpiredLeases」参照。

### 変更ファイル

- `packages/durably/src/storage.ts`
  - `releaseExpiredLeases()` を 2-phase に書き換え
  - Phase 1: 同一 concurrencyKey で pending が既にある expired lease → `status = 'failed'`, `error = 'Lease expired; pending run already exists'`
  - Phase 2: 残りの expired lease を per-row SAVEPOINT で `status = 'pending'` に戻す。conflict → `status = 'failed'`

### 完了条件

- `pnpm validate` が通る
- expired lease + 同一 concurrencyKey の pending がある場合 → expired lease は failed になる（pending に戻らない）
- expired lease + pending がない場合 → 従来通り pending に戻る

---

## Step 6: durably-react の更新

### 変更ファイル

- `packages/durably-react/src/types.ts`
  - `DurablyEvent` union に `run:coalesced` を追加
- `packages/durably-react/src/hooks/use-runs.ts`
  - `run:coalesced` で runs list をリフレッシュ
- `packages/durably-react/src/hooks/use-job-subscription.ts`
  - followLatest: `run:coalesced` で `dispatch({ type: 'switch_to_run' })` を追加
- `packages/durably-react/src/hooks/use-job.ts`
  - trigger の返り値型: `{ runId }` のまま（disposition は内部で使わない）

### 完了条件

- `pnpm validate` が通る
- `run:coalesced` SSE event を受信したとき runs list がリフレッシュされる
- followLatest が `run:coalesced` に反応する

---

## Step 7: Tests — coalesce テストスイート

RFC「Step 9: Tests」の 28 ケースを実装。

### 新規ファイル

- `packages/durably/tests/shared/coalesce.shared.ts` — shared test definitions
- `packages/durably/tests/node/coalesce.test.ts` — Node.js SQLite runner
- `packages/durably/tests/browser/coalesce.test.ts` — Browser WASM runner

### テストカテゴリ

1. concurrencyKey pending limit (7 cases)
2. coalesce behavior (3 cases)
3. disposition (3 cases)
4. events (3 cases)
5. batchTrigger (2 cases)
6. constraint identification (2 cases)
7. post-conflict race (1 case)
8. triggerAndWait (2 cases)
9. releaseExpiredLeases (2 cases)
10. validation (2 cases)
11. post-conflict edge (1 case)

### 完了条件

- `pnpm validate` が通る
- `pnpm test` で全 28 ケースが pass

---

## Step 8: Documentation

### 変更ファイル

- `packages/durably/docs/llms.md`
  - trigger() 返り値 → TriggerResult（disposition 付き）
  - concurrencyKey の pending 制限
  - coalesce: 'skip' オプション
  - ConflictError
- `pnpm --filter durably-website generate:llms` で再生成

### 完了条件

- `pnpm validate` が通る
- llms.md に全 API 変更が反映されている
- llms.txt が再生成されている

---

## Step 9: Cleanup

- この `PLAN.md` を削除
- `pnpm validate` で最終確認
