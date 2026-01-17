# Tasks: Streaming v2 実装

## Phase A: step.stream() 基本実装

- [ ] A.1 `step.stream()` メソッドを実装 (`context.ts`)
- [ ] A.2 `StreamEvent` 型を追加 (`events.ts`)
- [ ] A.3 `subscribe()` で `stream` イベントを配信
- [ ] A.4 テスト: stream の基本動作

## Phase B: イベント永続化と再接続

- [ ] B.1 `events` テーブルスキーマを追加 (`schema.ts`)
- [ ] B.2 マイグレーションを追加 (`migrations.ts`)
- [ ] B.3 `createEvent()`, `getEvents()` を Storage に追加
- [ ] B.4 粗いイベント (run:*, step:*) の永続化
- [ ] B.5 `subscribe()` に `resumeFrom` オプションを追加
- [ ] B.6 テスト: 再接続でイベント再生

## Phase C: チェックポイント（将来）

- [ ] C.1 `checkpoint()` API を設計
- [ ] C.2 チェックポイントからの再開サポート
- [ ] C.3 TTL によるイベントログのクリーンアップ
