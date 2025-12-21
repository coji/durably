# 再開可能性

Durablyの核心機能は自動的なジョブ再開です。このページではその仕組みを説明します。

## 仕組み

### ステップの永続化

すべての`context.run()`呼び出しがチェックポイントを作成します：

```ts
// ステップ1: 結果がSQLiteに永続化される
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // 5秒かかる
})

// ステップ2: ここでクラッシュした場合...
await context.run('process-users', async () => {
  await processAll(users)  // クラッシュ！
})

// ステップ3: 到達しない
await context.run('notify', async () => {
  await sendNotification()
})
```

### 再開時

ジョブが再開されると：

```ts
// ステップ1: キャッシュされた結果を即座に返す（APIコールなし）
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // スキップ！
})

// ステップ2: 最初から再実行
await context.run('process-users', async () => {
  await processAll(users)  // 再び実行
})

// ステップ3: 通常通り実行
await context.run('notify', async () => {
  await sendNotification()
})
```

## ハートビートメカニズム

Durablyはハートビートを使用して放棄されたジョブを検出します：

```ts
const durably = createDurably({
  dialect,
  heartbeatInterval: 5000,   // 5秒ごとにハートビートを更新
  staleThreshold: 30000,     // 30秒後に失効とみなす
})
```

### 仕組み

1. 実行中のジョブは定期的に`heartbeat_at`タイムスタンプを更新
2. ワーカーは失効したジョブ（`staleThreshold`ミリ秒間ハートビート更新なし）をチェック
3. 失効したジョブは`pending`にリセットされ、再び取得される

### ブラウザタブの処理

ブラウザでは、タブがサスペンドされることがあります。タブがアクティブになると：

1. ハートビートが再開
2. ジョブが失効としてマークされていた場合、最後のチェックポイントから再開

## 冪等性

ステップは安全に再実行できるように設計する必要があります：

### 良い例：冪等な操作

```ts
// insertの代わりにupsertを使用
await context.run('save-user', async () => {
  await db.upsertUser(user)  // リトライしても安全
})

// アクション前にチェック
await context.run('send-email', async () => {
  const sent = await db.wasEmailSent(userId)
  if (!sent) {
    await sendEmail(user)
    await db.markEmailSent(userId)
  }
})
```

### 注意：非冪等な操作

```ts
// 安全に繰り返せない操作には注意
await context.run('charge-card', async () => {
  // 決済プロバイダーには冪等性キーを使用
  await stripe.charges.create({
    amount: 1000,
    idempotency_key: `charge_${orderId}`,
  })
})
```

## ステップの部分的な完了

ステップが実行中にクラッシュした場合、ステップ全体が再実行されます：

```ts
await context.run('process-items', async () => {
  for (const item of items) {
    await processItem(item)  // 50アイテム後にクラッシュ
  }
  // 再開時: すべてのアイテムが再び処理される
})
```

大規模な操作の場合、より小さなステップに分割することを検討してください：

```ts
// より良い方法: バッチで処理
for (let i = 0; i < items.length; i += 100) {
  await context.run(`batch-${i}`, async () => {
    const batch = items.slice(i, i + 100)
    for (const item of batch) {
      await processItem(item)
    }
  })
}
```
