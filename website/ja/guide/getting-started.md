# はじめる

## インストール

::: code-group

```bash [npm]
npm install @coji/durably kysely zod
```

```bash [pnpm]
pnpm add @coji/durably kysely zod
```

```bash [yarn]
yarn add @coji/durably kysely zod
```

:::

### Node.js

Node.jsの場合、SQLiteドライバーも必要です：

::: code-group

```bash [libsql（推奨）]
npm install @libsql/client @libsql/kysely-libsql
```

```bash [better-sqlite3]
npm install better-sqlite3
```

:::

### ブラウザ

ブラウザの場合、OPFSを使用したSQLite WASMを使用します：

```bash
npm install sqlocal
```

## クイックスタート

### Node.jsの例

```ts
import { createDurably } from '@coji/durably'
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

// SQLiteクライアントを作成
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

// Durablyを初期化
const durably = createDurably({ dialect })

// ジョブを定義
const processOrder = durably.defineJob(
  {
    name: 'process-order',
    input: z.object({ orderId: z.string() }),
    output: z.object({ status: z.string() }),
  },
  async (step, payload) => {
    // ステップ1: 注文を検証
    const order = await step.run('validate', async () => {
      return await validateOrder(payload.orderId)
    })

    // ステップ2: 決済を処理
    await step.run('payment', async () => {
      await processPayment(order)
    })

    // ステップ3: 確認を送信
    await step.run('notify', async () => {
      await sendConfirmation(order)
    })

    return { status: 'completed' }
  },
)

// ワーカーを開始しマイグレーションを実行
await durably.migrate()
durably.start()

// ジョブをトリガー
await processOrder.trigger({ orderId: 'order_123' })
```

### ブラウザの例

```ts
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// OPFSを使用してSQLiteクライアントを作成
const { dialect } = new SQLocalKysely('app.sqlite3')

// Durablyを初期化
const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})

// Node.jsと同じ方法でジョブを定義して使用
const syncData = durably.defineJob(
  {
    name: 'sync-data',
    input: z.object({ userId: z.string() }),
  },
  async (step, payload) => {
    const data = await step.run('fetch', async () => {
      return await fetchUserData(payload.userId)
    })

    await step.run('save', async () => {
      await saveLocally(data)
    })
  },
)

await durably.migrate()
durably.start()
```

## 次のステップ

- [ジョブとステップ](/ja/guide/jobs-and-steps) - ジョブとステップの定義を学ぶ
- [再開可能性](/ja/guide/resumability) - 再開の仕組みを理解する
- [イベント](/ja/guide/events) - イベントでジョブ実行を監視する
