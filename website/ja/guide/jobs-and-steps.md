# ジョブとステップ

## ジョブの定義

ジョブは`durably.register(defineJob()`を使用して定義します：

```ts
const myJob = durably.register(defineJob(
  {
    name: 'my-job',
    input: z.object({ id: z.string() }),
    output: z.object({ result: z.string() }),
  },
  async (step, payload) => {
    // ジョブの実装
    return { result: 'done' }
  },
)
```

### ジョブオプション

| オプション | 型 | 必須 | 説明 |
|--------|------|----------|-------------|
| `name` | `string` | はい | 一意のジョブ識別子 |
| `input` | `ZodSchema` | はい | ジョブペイロードのスキーマ |
| `output` | `ZodSchema` | いいえ | ジョブ戻り値のスキーマ |

## ステップの作成

ステップは`step.run()`を使用して作成します：

```ts
const result = await step.run('step-name', async () => {
  // ステップのロジック
  return someValue
})
```

### ステップの動作

1. **初回実行**: 関数が実行され、戻り値が永続化される
2. **以降の実行**: 関数を実行せずに永続化された値が返される
3. **型推論**: 戻り値の型は関数から推論される

### ステップ名

ステップ名はジョブ内で一意である必要があります：

```ts
// 良い例 - 一意の名前
await step.run('fetch-user', async () => { ... })
await step.run('update-profile', async () => { ... })

// 悪い例 - 重複した名前は問題を引き起こす
await step.run('step', async () => { ... })
await step.run('step', async () => { ... }) // 正しく動作しない
```

## ジョブのトリガー

### 基本的なトリガー

```ts
await myJob.trigger({ id: 'abc123' })
```

### 冪等性キーを使用

ジョブの重複実行を防止：

```ts
await myJob.trigger(
  { id: 'abc123' },
  { idempotencyKey: 'unique-request-id' }
)
```

### 並行性キーを使用

並行実行を制御：

```ts
await myJob.trigger(
  { id: 'abc123' },
  { concurrencyKey: 'user_123' }
)
```

## ジョブのライフサイクル

```
trigger() → pending → running → completed
                  ↘           ↗
                    → failed
```

1. **pending**: ジョブがキューに入り、ワーカーを待機中
2. **running**: ワーカーがジョブを実行中
3. **completed**: ジョブが正常に完了
4. **failed**: ジョブでエラーが発生

## エラー処理

ステップ内のエラーはジョブの失敗を引き起こします：

```ts
await step.run('might-fail', async () => {
  if (someCondition) {
    throw new Error('何か問題が発生しました')
  }
  return result
})
```

ジョブのステータスは`failed`になり、エラーが保存されます。失敗したジョブは`durably.retry(runId)`を使用してリトライできます。
