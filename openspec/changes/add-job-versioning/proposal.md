# Change: Job Definition Auto-Versioning

## Why

When job definitions change during a Run's execution (especially with HITL where runs can wait for days), the resumed Run may behave unexpectedly. We need a mechanism to detect job definition changes and prevent incompatible runs from continuing.

## What Changes

- Auto-generate `job_hash` from job definition at registration time
- Store `job_hash` in Run record at trigger time
- Validate `job_hash` match when resuming/retrying Runs
- Add `allowIncompatible` option to bypass validation

## Impact

- Affected specs: `core`
- Affected code:
  - `packages/durably/src/job.ts` - hash 生成
  - `packages/durably/src/schema.ts` - `job_hash` カラム
  - `packages/durably/src/storage.ts` - hash 保存/検証
  - `packages/durably/src/durably.ts` - retry/resume 時のチェック
  - `packages/durably/src/migrations.ts` - job_hash マイグレーション
