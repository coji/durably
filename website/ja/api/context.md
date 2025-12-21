# Context

Contextオブジェクトはジョブハンドラーに渡され、ステップの作成とロギングのためのメソッドを提供します。

## メソッド

### `run()`

再開可能なステップを作成します。

```ts
const result = await context.run<T>(
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
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // 呼び出される
})

// 再開時: キャッシュされた結果を返す
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // 呼び出されない
})
```

### `log()`

現在の実行に関連するログエントリを書き込みます。

```ts
context.log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): void
```

| パラメータ | 型 | 説明 |
|-----------|------|-------------|
| `level` | `string` | ログレベル |
| `message` | `string` | ログメッセージ |
| `data` | `object` | オプションの構造化データ |

```ts
context.log('info', '処理を開始')
context.log('debug', 'ユーザーデータ', { userId: 'abc', count: 10 })
context.log('error', '取得に失敗', { error: err.message })
```

## プロパティ

### `runId`

現在の実行の一意の識別子。

```ts
const id: string = context.runId
```

### `stepIndex`

現在のステップインデックス（0始まり）。

```ts
const index: number = context.stepIndex
```

## 例

```ts
durably.defineJob(
  {
    name: 'process-order',
    input: z.object({ orderId: z.string() }),
  },
  async (context, payload) => {
    context.log('info', '注文処理を開始', { orderId: payload.orderId })

    // ステップ1
    const order = await context.run('fetch-order', async () => {
      context.log('debug', 'APIから注文を取得中')
      return await api.getOrder(payload.orderId)
    })

    // ステップ2
    await context.run('validate', async () => {
      if (!order.items.length) {
        throw new Error('注文に商品がありません')
      }
      context.log('info', '注文を検証', { itemCount: order.items.length })
    })

    // ステップ3
    await context.run('process-payment', async () => {
      context.log('info', '決済を処理中')
      await payments.charge(order.total)
    })

    context.log('info', '注文処理完了')
    return { success: true }
  },
)
```

## ステップ命名のベストプラクティス

### 説明的な名前を使用

```ts
// 良い例
await context.run('fetch-user-profile', ...)
await context.run('validate-payment-info', ...)
await context.run('send-confirmation-email', ...)

// 悪い例
await context.run('step1', ...)
await context.run('s2', ...)
```

### ループには動的な名前

```ts
for (const item of items) {
  await context.run(`process-item-${item.id}`, async () => {
    await processItem(item)
  })
}
```

### 重複した名前を避ける

```ts
// これは問題を引き起こす
await context.run('fetch', async () => { ... })
await context.run('fetch', async () => { ... })  // 間違い！

// 一意の名前を使用
await context.run('fetch-users', async () => { ... })
await context.run('fetch-orders', async () => { ... })
```
