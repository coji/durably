# 将来仕様: PostgreSQL 対応プラン

> **⚠️ 注意: これは将来拡張の構想ドキュメントです。**
>
> 現状の durably は SQLite 前提であり、PostgreSQL は未検証です。

## 背景

SQLite 前提の単一プロセス設計から、PostgreSQL + 複数ワーカー運用へ拡張したい。
そのために、Run の取得と concurrencyKey の排他を DB レベルで保証する必要がある。

## 目的 / スコープ

- PostgreSQL dialect での動作をまずは **実験的** に提供する
- 複数ワーカーでも **同一 Run を二重実行しない**
- concurrencyKey を **グローバルに** 保護する
- SQLite の既存挙動は維持する（PG のみ分岐）
- **HITL / streaming / job versioning は SQLite 前提で先行実装**し、PG は後追いで整合させる

## 非目標

- 分散キュー/スケジューラの実装
- 他 DB への汎用抽象化

---

## 設計方針（必要十分）

### 1. Run の claim を原子化

- PG は **単一トランザクション** で「pending → running」に更新して取得する
- SQLite は現行ロジックを維持する

### 2. concurrencyKey は Lock Table で保護

- `durably_concurrency_locks` を追加し、claim 時にロックを取得する
- Run 完了/失敗/キャンセル時にロックを解放する
- 同一 concurrencyKey の **同時 running を禁止**する（pending は許容）

### 3. stale run の回収ルール

- 各ワーカーがポーリング周期で `recoverStaleRuns()` を実行
- **recover → claim** の順序を統一する
- stale 判定は `status = 'running'` かつ `heartbeat_at` が閾値超過

### 4. 互換性と段階

- SQLite の挙動は不変
- PG は **実験的** と明記し、テスト整備後に安定化へ

---

## テスト観点

- **2ワーカー同時:** 同一 Run を二重で拾えない
- **concurrencyKey:** 同一 key の run が同時に running にならない
- **stale run:** heartbeat なしの run が pending に戻り、再度 claim される
