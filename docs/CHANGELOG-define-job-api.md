# API 変更: defineJob() + register() パターン

このドキュメントは `feature/define-job-api` ブランチで実装する `@coji/durably` の API 変更を整理したものである。

## 変更の目的

React などのフレームワーク統合を見据え、ジョブ定義を durably インスタンスから分離する。これにより：

1. **ジョブ定義の再利用**: 複数のコンポーネントやモジュールから同じジョブ定義を import できる
2. **静的な型チェック**: ジョブ定義時点で入出力の型が確定し、エディタ補完が効く
3. **テスタビリティ向上**: durably インスタンスなしでジョブ定義をテストできる
4. **遅延登録**: 実行時に必要なジョブだけを登録できる

## API 変更サマリー

### Before（旧 API）

```ts
import { createDurably } from '@coji/durably'
import { z } from 'zod'

const durably = createDurably({ dialect })

// defineJob は durably のメソッド
// 呼び出し時点で登録される
const syncUsers = durably.defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
}, async (step, payload) => {
  // ...
  return { syncedCount: 0 }
})

// 直接 trigger
await syncUsers.trigger({ orgId: 'org_123' })
```

### After（新 API）

```ts
// jobs.ts - ジョブ定義（durably インスタンス不要）
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const syncUsers = defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
  run: async (step, payload) => {
    // ...
    return { syncedCount: 0 }
  },
})

// main.ts - 実行時に登録
import { createDurably } from '@coji/durably'
import { syncUsers } from './jobs'

const durably = createDurably({ dialect })
await durably.migrate()
durably.start()

// register で JobHandle を取得
const syncUsersJob = durably.register(syncUsers)

// JobHandle 経由で trigger
await syncUsersJob.trigger({ orgId: 'org_123' })
```

## 型定義の変更

### JobDefinition（新規）

ジョブの静的な定義。実行可能ではない。

```ts
interface JobDefinition<TName extends string, TInput, TOutput> {
  readonly name: TName
  readonly inputSchema: z.ZodSchema<TInput>
  readonly outputSchema: z.ZodSchema<TOutput>
  readonly run: (step: StepContext, payload: TInput) => Promise<TOutput>
}
```

### JobHandle（既存、変更なし）

`register()` から返される実行可能なハンドル。

```ts
interface JobHandle<TName extends string, TInput, TOutput> {
  readonly name: TName
  trigger(input: TInput, options?: TriggerOptions): Promise<Run<TOutput>>
  triggerAndWait(input: TInput, options?: TriggerOptions): Promise<{ id: string; output: TOutput }>
  batchTrigger(inputs: BatchTriggerInput<TInput>[]): Promise<Run<TOutput>[]>
  getRun(id: string): Promise<Run<TOutput> | null>
  getRuns(filter?: RunFilter): Promise<Run<TOutput>[]>
}
```

## 関数シグネチャの変更

### defineJob（変更）

**Before:**
```ts
// durably のメソッド、第2引数が処理関数
durably.defineJob(
  { name, input, output },
  async (step, payload) => { ... }
): JobHandle
```

**After:**
```ts
// スタンドアロン関数、run プロパティに処理関数
defineJob({
  name,
  input,
  output,
  run: async (step, payload) => { ... }
}): JobDefinition
```

### register（新規）

```ts
durably.register(jobDefinition: JobDefinition): JobHandle
```

- 同じ `JobDefinition` を複数回 `register` しても、同名のジョブは一度だけ登録される
- 内部的には Map で管理し、重複登録を防ぐ

## 実装タスク

### 1. コアライブラリ（@coji/durably）

- [ ] `defineJob` 関数をスタンドアロン関数として実装
- [ ] `JobDefinition` 型を定義
- [ ] `durably.register(jobDef)` メソッドを追加
- [ ] `durably.defineJob()` を削除
- [ ] 既存テストを新 API に移行

### 2. エクスポート構成

```ts
// @coji/durably
export { createDurably } from './durably'
export { defineJob } from './define-job'
export type { JobDefinition, JobHandle, ... } from './types'
```

## 移行ガイド

### Step 1: import の変更

```diff
- import { createDurably } from '@coji/durably'
+ import { createDurably, defineJob } from '@coji/durably'
```

### Step 2: ジョブ定義の分離

```diff
- const syncUsers = durably.defineJob({
+ export const syncUsers = defineJob({
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
    output: z.object({ syncedCount: z.number() }),
- }, async (step, payload) => {
+   run: async (step, payload) => {
      // ...
      return { syncedCount: 0 }
- })
+   },
+ })
```

### Step 3: register の追加

```diff
  const durably = createDurably({ dialect })
  await durably.migrate()
  durably.start()

+ const syncUsersJob = durably.register(syncUsers)
- await syncUsers.trigger({ orgId: 'org_123' })
+ await syncUsersJob.trigger({ orgId: 'org_123' })
```

## React 統合での活用

この API 変更により、React での利用が簡潔になる：

```tsx
// jobs.ts
export const processTask = defineJob({
  name: 'process-task',
  input: z.object({ taskId: z.string() }),
  output: z.object({ success: z.boolean() }),
  run: async (step, payload) => {
    await step.run('process', () => process(payload.taskId))
    return { success: true }
  },
})

// component.tsx
import { useJob } from '@coji/durably-react'
import { processTask } from './jobs'

function TaskRunner() {
  // useJob 内部で durably.register(processTask) を実行
  const { trigger, status, output, isReady } = useJob(processTask)

  return (
    <button
      onClick={() => trigger({ taskId: '123' })}
      disabled={!isReady}
    >
      Run
    </button>
  )
}
```

## 互換性

このブランチでは旧 API（`durably.defineJob()`）を完全に削除し、新 API のみをサポートする。

破壊的変更のため、既存コードは移行が必要。
