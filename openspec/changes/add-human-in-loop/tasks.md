# Tasks: Human-in-the-Loop (HITL) 実装

## 1. DB スキーマ拡張

- [ ] 1.1 `RunsTable` に `wait_*` フィールドを追加 (`schema.ts`)
- [ ] 1.2 `StepsTable` に `step_type`, `human_payload`, `human_decision` を追加
- [ ] 1.3 マイグレーション version 2 を追加 (`migrations.ts`)
- [ ] 1.4 `Run` インターフェースに wait 関連フィールドを追加 (`storage.ts`)

## 2. Core API 実装

- [ ] 2.1 `WaitHumanSignal` エラークラスを追加 (`errors.ts`)
- [ ] 2.2 `ctx.human()` メソッドを実装 (`context.ts`)
- [ ] 2.3 `durably.resume()` メソッドを実装 (`durably.ts`)
- [ ] 2.4 `waiting_human` ステータスを型定義に追加

## 3. Worker 変更

- [ ] 3.1 `WaitHumanSignal` を catch して `waiting_human` 状態を維持
- [ ] 3.2 期限切れ Run の回収ロジックを追加
- [ ] 3.3 replay 時の `ctx.human()` 挙動を実装（既存 human step があれば即解決）

## 4. Storage 拡張

- [ ] 4.1 `getRunByToken()` メソッドを追加
- [ ] 4.2 `getExpiredHumanWaitRuns()` メソッドを追加
- [ ] 4.3 resume 時の楽観的更新クエリを実装

## 5. HTTP API 拡張

- [ ] 5.1 `POST /resume` ハンドラを追加 (`server.ts`)
- [ ] 5.2 `GET /runs` に `includeToken` オプションを追加
- [ ] 5.3 エラーレスポンス (404, 409, 410) を実装

## 6. イベント追加

- [ ] 6.1 `run:wait_human` イベントを追加 (`events.ts`)
- [ ] 6.2 `run:resume` イベントを追加

## 7. テスト

- [ ] 7.1 `ctx.human()` の基本動作テスト
- [ ] 7.2 `resume()` の成功・失敗テスト
- [ ] 7.3 replay 時の挙動テスト
- [ ] 7.4 期限切れ Run の回収テスト
- [ ] 7.5 HTTP API テスト

## 8. ドキュメント

- [ ] 8.1 `packages/durably/docs/llms.md` を更新
- [ ] 8.2 README に HITL セクションを追加
