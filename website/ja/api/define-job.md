# defineJob

型付き入出力と実行関数を持つ新しいジョブ定義を作成します。

## シグネチャ

```ts
import { defineJob } from '@coji/durably'

const jobDef = defineJob<TName, TInput, TOutput>({
  name: TName,
  input: z.ZodType<TInput>,
  output?: z.ZodType<TOutput>,
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
})
```

## オプション

```ts
interface DefineJobConfig<TName, TInput, TOutput> {
  name: TName
  input: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
}
```

| オプション | 型 | 必須 | 説明 |
|--------|------|----------|-------------|
| `name` | `string` | はい | ジョブの一意の識別子 |
| `input` | `ZodSchema` | はい | ジョブ入力を検証するZodスキーマ |
| `output` | `ZodSchema` | いいえ | ジョブ出力を検証するZodスキーマ |
| `run` | `Function` | はい | ジョブの実行関数 |

## 実行関数

実行関数は以下を受け取ります：

- `step`: ステップの作成とロギングのための[Step](/ja/api/step)オブジェクト
- `payload`: 検証済みの入力ペイロード

## 戻り値

`durably.register()`で登録できる`JobDefinition`オブジェクトを返します。

## ジョブの登録

`durably.register()`を使用してジョブ定義を登録し、ジョブハンドルを取得します：

```ts
const job = durably.register(jobDef)
```

ジョブハンドルは以下のメソッドを提供します：

### `trigger()`

```ts
await job.trigger(
  input: TInput,
  options?: TriggerOptions
): Promise<Run<TOutput>>
```

新しいジョブ実行をトリガーします。

#### トリガーオプション

```ts
interface TriggerOptions {
  idempotencyKey?: string
  concurrencyKey?: string
}
```

| オプション | 説明 |
|--------|-------------|
| `idempotencyKey` | 同じキーでの重複実行を防止 |
| `concurrencyKey` | 並行性制御のためにジョブをグループ化 |

## 例

```ts
import { createDurably, defineJob } from '@coji/durably'
import { z } from 'zod'

// ジョブを定義
const syncUsersJob = defineJob({
  name: 'sync-users',
  input: z.object({
    orgId: z.string(),
    force: z.boolean().optional(),
  }),
  output: z.object({
    syncedCount: z.number(),
    errors: z.array(z.string()),
  }),
  run: async (step, payload) => {
    const users = await step.run('fetch-users', async () => {
      return await api.fetchUsers(payload.orgId)
    })

    const errors: string[] = []
    for (const user of users) {
      await step.run(`sync-${user.id}`, async () => {
        try {
          await db.upsertUser(user)
        } catch (e) {
          errors.push(`${user.id}の同期に失敗`)
        }
      })
    }

    return {
      syncedCount: users.length - errors.length,
      errors,
    }
  },
})

// durablyインスタンスに登録
const syncUsers = durably.register(syncUsersJob)

// ジョブをトリガー
await syncUsers.trigger({ orgId: 'org_123' })

// 冪等性付き
await syncUsers.trigger(
  { orgId: 'org_123' },
  { idempotencyKey: 'sync-org_123-2024-01-01' }
)
```

## 型推論

入出力の型はZodスキーマから推論されます：

```ts
const exampleJob = defineJob({
  name: 'example',
  input: z.object({ id: z.string() }),
  output: z.object({ result: z.number() }),
  run: async (step, payload) => {
    // payloadは{ id: string }として型付け
    return { result: 42 }  // 出力スキーマと一致する必要あり
  },
})

const job = durably.register(exampleJob)

// trigger()は型付けされている
await job.trigger({ id: 'abc' })  // OK
await job.trigger({ wrong: 1 })   // 型エラー
```

## 冪等な登録

同じ`JobDefinition`インスタンスを複数回登録しても、同じジョブハンドルが返されます：

```ts
const jobDef = defineJob({ name: 'my-job', ... })

const handle1 = durably.register(jobDef)
const handle2 = durably.register(jobDef)

console.log(handle1 === handle2) // true
```

これにより、エフェクトが複数回実行される可能性のあるReactコンポーネントでも安全に使用できます。
