# Node.js

このガイドでは、Node.js環境でのDurablyの使用方法を説明します。

## SQLiteドライバー

DurablyはKysely互換のSQLiteダイアレクトで動作します。

### Turso / libsql（推奨）

[Turso](https://turso.tech)は[libsql](https://github.com/tursodatabase/libsql)上に構築されたSQLite互換データベースです。開発にはローカルファイル、本番にはTurso cloudを使用します：

```ts
import { LibsqlDialect } from '@libsql/kysely-libsql'

// ローカル開発
const dialect = new LibsqlDialect({
  url: 'file:local.db',
})

// 本番（Turso cloud）
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const durably = createDurably({ dialect })
```

依存関係をインストール：

```bash
npm install @libsql/client @libsql/kysely-libsql
```

### better-sqlite3

[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)は同期的なSQLiteドライバーです：

```ts
import SQLite from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

const database = new SQLite('local.db')
const dialect = new SqliteDialect({ database })

const durably = createDurably({ dialect })
```

## 設定

```ts
const durably = createDurably({
  dialect,
  pollingInterval: 1000,    // 1秒ごとに保留中のジョブをチェック
  heartbeatInterval: 5000,  // 5秒ごとにハートビートを更新
  staleThreshold: 30000,    // 30秒後にジョブを失効としてマーク
})
```

## ライフサイクル

```ts
// データベースマイグレーションを実行
await durably.migrate()

// ワーカーを開始
durably.start()

// ジョブをトリガー
await myJob.trigger({ data: 'value' })

// 正常に停止
await durably.stop()
```

## プロセスシグナル

グレースフルシャットダウンを処理：

```ts
process.on('SIGTERM', async () => {
  console.log('シャットダウン中...')
  await durably.stop()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('中断されました...')
  await durably.stop()
  process.exit(0)
})
```

## ワーカーパターン

### シングルワーカー

最もシンプルなパターン - プロセスごとに1つのワーカー：

```ts
const durably = createDurably({ dialect })
await durably.migrate()
durably.start()
```

### 複数プロセス

Durablyは複数のワーカーがジョブを競合して取得することをサポートします：

```ts
// worker-1.ts
const durably = createDurably({ dialect })
durably.start()

// worker-2.ts（別プロセス）
const durably = createDurably({ dialect })
durably.start()
```

ジョブはアトミックに取得され、1つのワーカーのみが各ジョブを処理します。

## エラー処理

```ts
durably.on('run:fail', (event) => {
  console.error(`ジョブ ${event.runId} が失敗:`, event.error)

  // エラートラッキングに送信
  Sentry.captureException(new Error(event.error), {
    extra: { runId: event.runId, jobName: event.jobName },
  })
})
```

## 失敗したジョブのリトライ

```ts
// 失敗した実行を取得
const failedRuns = await durably.getFailedRuns()

// 特定の実行をリトライ
await durably.retry(failedRuns[0].id)
```

## フレームワークとの統合

### Express

```ts
import express from 'express'

const app = express()

app.post('/api/trigger-job', async (req, res) => {
  const { id } = req.body
  await myJob.trigger({ id })
  res.json({ status: 'triggered' })
})

// 両方を開始
await durably.migrate()
durably.start()
app.listen(3000)
```

### Fastify

```ts
import Fastify from 'fastify'

const fastify = Fastify()

fastify.post('/api/trigger-job', async (req) => {
  await myJob.trigger(req.body)
  return { status: 'triggered' }
})

await durably.migrate()
durably.start()
await fastify.listen({ port: 3000 })
```
