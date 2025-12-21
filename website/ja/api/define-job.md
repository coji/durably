# defineJob

型付き入出力を持つ新しいジョブを定義します。

## シグネチャ

```ts
durably.defineJob<I, O>(
  options: JobOptions<I, O>,
  handler: (context: Context, payload: I) => Promise<O>
): Job<I, O>
```

## オプション

```ts
interface JobOptions<I, O> {
  name: string
  input: z.ZodType<I>
  output?: z.ZodType<O>
}
```

| オプション | 型 | 必須 | 説明 |
|--------|------|----------|-------------|
| `name` | `string` | はい | ジョブの一意の識別子 |
| `input` | `ZodSchema` | はい | ジョブ入力を検証するZodスキーマ |
| `output` | `ZodSchema` | いいえ | ジョブ出力を検証するZodスキーマ |

## ハンドラー

ハンドラー関数は以下を受け取ります：

- `context`: ステップの作成とロギングのための[Context](/ja/api/context)オブジェクト
- `payload`: 検証済みの入力ペイロード

## 戻り値

以下のメソッドを持つ`Job`オブジェクトを返します：

### `trigger()`

```ts
await job.trigger(
  input: I,
  options?: TriggerOptions
): Promise<void>
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
import { z } from 'zod'

const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({
      orgId: z.string(),
      force: z.boolean().optional(),
    }),
    output: z.object({
      syncedCount: z.number(),
      errors: z.array(z.string()),
    }),
  },
  async (context, payload) => {
    const users = await context.run('fetch-users', async () => {
      return await api.fetchUsers(payload.orgId)
    })

    const errors: string[] = []
    for (const user of users) {
      await context.run(`sync-${user.id}`, async () => {
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
)

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
const job = durably.defineJob(
  {
    name: 'example',
    input: z.object({ id: z.string() }),
    output: z.object({ result: z.number() }),
  },
  async (context, payload) => {
    // payloadは{ id: string }として型付け
    return { result: 42 }  // 出力スキーマと一致する必要あり
  },
)

// trigger()は型付けされている
await job.trigger({ id: 'abc' })  // OK
await job.trigger({ wrong: 1 })   // 型エラー
```
