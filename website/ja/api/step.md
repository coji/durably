# Step

Stepオブジェクトはジョブハンドラーに渡され、ステップの作成とロギングのためのメソッドを提供します。

## メソッド

### `run()`

再開可能なステップを作成します。

```ts
const result = await step.run<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T>
```

| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `name` | `string` | ジョブ内で一意のステップ名 |
| `fn` | `() => Promise<T>` | 実行する非同期関数 |

**戻り値**: `fn`の結果。新しく計算されたものか、キャッシュから取得されたもの。

#### 動作

1. **初回実行**: `fn`を実行し、結果を永続化
2. **以降の実行**: `fn`を実行せずにキャッシュされた結果を返す

```ts
// 初回実行: APIが呼び出され、結果がキャッシュされる
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers()  // 呼び出される
})

// 再開時: キャッシュされた結果を返す
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers()  // 呼び出されない
})
```

### `log`

構造化ログを書き込むためのロガーオブジェクト。

```ts
step.log.info(message: string, data?: Record<string, unknown>): void
step.log.warn(message: string, data?: Record<string, unknown>): void
step.log.error(message: string, data?: Record<string, unknown>): void
```

| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `message` | `string` | ログメッセージ |
| `data` | `object` | オプションの構造化データ |

```ts
step.log.info('処理を開始')
step.log.info('ユーザーデータ', { userId: 'abc', count: 10 })
step.log.error('取得に失敗', { error: err.message })
```

### `progress()`

現在の実行の進捗を報告します。

```ts
step.progress(current: number, total: number, message?: string): void
```

| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `current` | `number` | 現在の進捗値 |
| `total` | `number` | 全体の進捗値 |
| `message` | `string` | オプションの進捗メッセージ |

```ts
step.progress(0, 100, '開始中...')
step.progress(50, 100, '半分完了')
step.progress(100, 100, '完了')
```

## プロパティ

### `runId`

現在の実行の一意の識別子。

```ts
const id: string = step.runId
```

### `stepIndex`

現在のステップインデックス（0始まり）。

```ts
const index: number = step.stepIndex
```

## 例

```ts
durably.register(defineJob(
  {
    name: 'process-order',
    input: z.object({ orderId: z.string() }),
  },
  async (step, payload) => {
    step.log.info('注文処理を開始', { orderId: payload.orderId })

    // ステップ1
    const order = await step.run('fetch-order', async () => {
      step.log.info('APIから注文を取得中')
      return await api.getOrder(payload.orderId)
    })

    // ステップ2
    await step.run('validate', async () => {
      if (!order.items.length) {
        throw new Error('注文に商品がありません')
      }
      step.log.info('注文を検証', { itemCount: order.items.length })
    })

    // ステップ3
    await step.run('process-payment', async () => {
      step.log.info('決済を処理中')
      await payments.charge(order.total)
    })

    step.log.info('注文処理完了')
    return { success: true }
  },
)
```

## ステップ命名のベストプラクティス

### 説明的な名前を使用

```ts
// 良い例
await step.run('fetch-user-profile', ...)
await step.run('validate-payment-info', ...)
await step.run('send-confirmation-email', ...)

// 悪い例
await step.run('step1', ...)
await step.run('s2', ...)
```

### ループには動的な名前

```ts
for (const item of items) {
  await step.run(`process-item-${item.id}`, async () => {
    await processItem(item)
  })
}
```

### 重複した名前を避ける

```ts
// これは問題を引き起こす
await step.run('fetch', async () => { ... })
await step.run('fetch', async () => { ... })  // 間違い！

// 一意の名前を使用
await step.run('fetch-users', async () => { ... })
await step.run('fetch-orders', async () => { ... })
```
