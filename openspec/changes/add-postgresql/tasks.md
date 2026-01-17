# Tasks: PostgreSQL サポート実装

## 1. スキーマ拡張

- [ ] 1.1 `durably_concurrency_locks` テーブルスキーマを追加
- [ ] 1.2 PG 固有のマイグレーションパスを作成
- [ ] 1.3 マイグレーションで dialect 検出を処理

## 2. アトミックな Run Claiming

- [ ] 2.1 PG 用の `FOR UPDATE SKIP LOCKED` claiming を実装
- [ ] 2.2 SQLite の claiming ロジックは変更なし
- [ ] 2.3 claiming を dialect 固有メソッドに抽象化

## 3. Concurrency Key 保護

- [ ] 3.1 claim 時に `durably_concurrency_locks` でロックを取得
- [ ] 3.2 Run 完了/失敗/キャンセル時にロックを解放
- [ ] 3.3 同じ `concurrency_key` の同時実行を防止

## 4. Stale Run リカバリ

- [ ] 4.1 PG 用の `recoverStaleRuns()` を実装
- [ ] 4.2 recover → claim の順序を保証
- [ ] 4.3 孤立したロックを解放

## 5. テスト

- [ ] 5.1 2 ワーカー同時 claim テスト
- [ ] 5.2 concurrency key 相互排他テスト
- [ ] 5.3 stale run リカバリテスト
- [ ] 5.4 SQLite テストが引き続きパスすることを確認

## 6. ドキュメント

- [ ] 6.1 PG 接続セットアップを文書化
- [ ] 6.2 examples/ に PG サンプルを追加
- [ ] 6.3 「experimental」ステータスを記載
