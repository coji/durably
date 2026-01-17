# Change: Job Definition 自動バージョニング

## Why

Run 実行中に Job 定義が変更されると（特に HITL では数日待機することもある）、再開時に予期しない動作をする可能性がある。Job 定義の変更を検出し、互換性のない Run の継続を防ぐ仕組みが必要。

## What Changes

- 登録時に Job 定義から `job_hash` を自動生成
- trigger 時に `job_hash` を Run レコードに保存
- resume/retry 時に `job_hash` の一致を検証
- 検証をバイパスする `allowIncompatible` オプションを追加

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/job.ts` - hash 生成
  - `packages/durably/src/schema.ts` - `job_hash` カラム
  - `packages/durably/src/storage.ts` - hash 保存/検証
  - `packages/durably/src/durably.ts` - retry/resume 時のチェック
  - `packages/durably/src/migrations.ts` - job_hash マイグレーション
