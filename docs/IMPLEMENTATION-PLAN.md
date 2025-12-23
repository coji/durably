# 実装計画書: defineJob() + register() パターン

このドキュメントは `feature/define-job-api` ブランチで実装する変更の詳細な実装計画である。

## 変更対象一覧

### サマリー

| カテゴリ | ファイル数 | 変更箇所数 | 優先度 |
|---------|----------|-----------|-------|
| ソースコード | 3 | 3 | 高 |
| テスト | 8 | 79 | 高 |
| ドキュメント（llms.md） | 1 | 2 | 高 |
| Examples | 3 | 3 | 中 |

---

## Phase 1: コアライブラリ整備

### 1.1 スタンドアロン defineJob 関数の作成

**ファイル**: `packages/durably/src/define-job.ts`（新規作成）

```ts
import type { z } from 'zod'

export interface JobDefinition<
  TName extends string,
  TInput,
  TOutput,
> {
  readonly name: TName
  readonly input: z.ZodSchema<TInput>
  readonly output: z.ZodSchema<TOutput>
  readonly run: (step: StepContext, payload: TInput) => Promise<TOutput>
}

export function defineJob<
  TName extends string,
  TInput,
  TOutput,
>(config: {
  name: TName
  input: z.ZodSchema<TInput>
  output: z.ZodSchema<TOutput>
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
}): JobDefinition<TName, TInput, TOutput> {
  return {
    name: config.name,
    input: config.input,
    output: config.output,
    run: config.run,
  }
}
```

### 1.2 durably.register() メソッドの追加

**ファイル**: `packages/durably/src/durably.ts`

**変更内容**:
- `register(jobDef: JobDefinition): JobHandle` メソッドを追加
- 既存の `defineJob()` メソッドを削除

```ts
// Before
defineJob<TName, TInput, TOutput>(
  config: JobConfig<TName, TInput, TOutput>,
  run: JobRunFn<TInput, TOutput>,
): JobHandle<TName, TInput, TOutput>

// After
register<TName, TInput, TOutput>(
  jobDef: JobDefinition<TName, TInput, TOutput>,
): JobHandle<TName, TInput, TOutput>
```

### 1.3 エクスポートの更新

**ファイル**: `packages/durably/src/index.ts`

**追加エクスポート**:
```ts
// 関数
export { defineJob } from './define-job'

// 型
export type { JobDefinition } from './define-job'
export type { JobHandle, StepContext, TriggerAndWaitResult } from './job'
```

---

## Phase 2: テストの移行

### 対象ファイル一覧

| ファイル | 変更箇所数 |
|---------|----------|
| `tests/shared/run-api.shared.ts` | 20+ |
| `tests/shared/recovery.shared.ts` | 19 |
| `tests/shared/job.shared.ts` | 11 |
| `tests/shared/step.shared.ts` | 8 |
| `tests/shared/worker.shared.ts` | 7 |
| `tests/shared/log.shared.ts` | 6 |
| `tests/shared/concurrency.shared.ts` | 4 |
| `tests/shared/plugin.shared.ts` | 4 |

### 移行パターン

**Before（旧 API）**:
```ts
const job = durably.defineJob(
  {
    name: 'test-job',
    input: z.object({ value: z.number() }),
    output: z.object({ result: z.number() }),
  },
  async (_step, _payload) => {
    return { result: 42 }
  },
)

await job.trigger({ value: 1 })
```

**After（新 API）**:
```ts
import { defineJob } from '@coji/durably'

const testJobDef = defineJob({
  name: 'test-job',
  input: z.object({ value: z.number() }),
  output: z.object({ result: z.number() }),
  run: async (_step, _payload) => {
    return { result: 42 }
  },
})

const job = durably.register(testJobDef)
await job.trigger({ value: 1 })
```

### 特別対応: 重複登録テスト

**ファイル**: `tests/shared/job.shared.ts`

旧 API では `defineJob()` を同名で2回呼ぶとエラーになったが、新 API では:
- 同じ `JobDefinition` を複数回 `register()` → OK（冪等）
- 異なる `JobDefinition` を同名で `register()` → エラー

テストを以下のように修正:

```ts
it('returns same JobHandle for same JobDefinition', () => {
  const jobDef = defineJob({ name: 'idempotent-job', ... })

  const handle1 = durably.register(jobDef)
  const handle2 = durably.register(jobDef)

  expect(handle1).toBe(handle2)
})

it('throws if different JobDefinition has same name', () => {
  const jobDef1 = defineJob({ name: 'conflict-job', run: async () => ({ a: 1 }) })
  const jobDef2 = defineJob({ name: 'conflict-job', run: async () => ({ b: 2 }) })

  durably.register(jobDef1)

  expect(() => durably.register(jobDef2)).toThrow(/already registered|conflict/i)
})
```

---

## Phase 3: ドキュメント更新

### 3.1 llms.md（LLM 向けドキュメント）

**ファイル**: `packages/durably/docs/llms.md`

**変更箇所**:

1. **Quick Start セクション（行 44-63）**

Before:
```ts
const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
    output: z.object({ syncedCount: z.number() }),
  },
  async (step, payload) => { ... },
)
```

After:
```ts
import { defineJob } from '@coji/durably'

const syncUsers = defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
  run: async (step, payload) => { ... },
})

const syncUsersJob = durably.register(syncUsers)
```

2. **ブラウザ例（行 225 付近）**
   - 同様のパターンで更新

---

## Phase 4: Examples 更新

### 4.1 Node.js Example

**ファイル**: `examples/node/basic.ts`

**構成変更**:
```
examples/node/
├── jobs.ts      # ジョブ定義（新規）
└── main.ts      # 実行（basic.ts をリネーム）
```

**jobs.ts**:
```ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const syncUsers = defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
  run: async (step, payload) => {
    // ...
  },
})
```

**main.ts**:
```ts
import { createDurably } from '@coji/durably'
import { syncUsers } from './jobs'

const durably = createDurably({ dialect })
await durably.migrate()
durably.start()

const syncUsersJob = durably.register(syncUsers)
await syncUsersJob.trigger({ orgId: 'org_123' })
```

### 4.2 Browser Example

**ファイル**: `examples/browser/src/main.ts`

同様のパターンで更新。

### 4.3 React Example

**ファイル**: `examples/react/src/App.tsx`

**変更**:
- ジョブ定義を `jobs.ts` に分離
- `useJob` フックの活用例を追加（将来の `@coji/durably-react` を想定）

---

## 実装順序

### Step 1: コア実装（必須）
- [ ] `src/define-job.ts` 新規作成
- [ ] `src/durably.ts` に `register()` 追加、`defineJob()` 削除
- [ ] `src/index.ts` エクスポート更新

### Step 2: テスト移行（必須）
- [ ] `tests/shared/job.shared.ts` - 重複登録テストの修正
- [ ] `tests/shared/step.shared.ts`
- [ ] `tests/shared/worker.shared.ts`
- [ ] `tests/shared/log.shared.ts`
- [ ] `tests/shared/concurrency.shared.ts`
- [ ] `tests/shared/plugin.shared.ts`
- [ ] `tests/shared/run-api.shared.ts`
- [ ] `tests/shared/recovery.shared.ts`

### Step 3: ドキュメント更新（必須）
- [ ] `packages/durably/docs/llms.md`

### Step 4: Examples 更新（推奨）
- [ ] `examples/node/basic.ts`
- [ ] `examples/browser/src/main.ts`
- [ ] `examples/react/src/App.tsx`

### Step 5: 検証
- [ ] `pnpm test` - 全テスト通過
- [ ] `pnpm validate` - lint, typecheck 通過
- [ ] Examples の動作確認

---

## チェックリスト

### 破壊的変更の確認

- [x] `durably.defineJob()` → 削除
- [x] `defineJob()` → スタンドアロン関数として追加
- [x] `durably.register()` → 新規追加

### 型安全性の確認

- [ ] `JobDefinition` の型パラメータが正しく推論される
- [ ] `JobHandle` の型パラメータが `register()` から正しく引き継がれる
- [ ] `trigger()` の引数が入力スキーマに従って型チェックされる

### 後方互換性

- **なし**: このブランチは破壊的変更を含む
- 移行ガイドは `docs/CHANGELOG-define-job-api.md` に記載済み
