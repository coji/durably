# APIリファレンス

このセクションではDurablyの詳細なAPIドキュメントを提供します。

## コアAPI

| エクスポート | 説明 |
|--------|-------------|
| [`createDurably`](/ja/api/create-durably) | Durablyインスタンスを作成 |
| [`defineJob`](/ja/api/define-job) | ジョブを定義（インスタンス経由） |
| [`Step`](/ja/api/step) | ジョブハンドラー用のステップコンテキスト |
| [`Events`](/ja/api/events) | イベント型と購読 |

## クイックリファレンス

### インスタンスの作成

```ts
import { createDurably } from '@coji/durably'

const durably = createDurably({
  dialect,                    // Kysely SQLiteダイアレクト
  pollingInterval: 1000,      // ワーカーポーリング間隔（ミリ秒）
  heartbeatInterval: 5000,    // ハートビート更新間隔（ミリ秒）
  staleThreshold: 30000,      // ジョブが失効とみなされるまでの時間（ミリ秒）
})
```

### インスタンスメソッド

```ts
// ライフサイクル
await durably.migrate()       // データベースマイグレーションを実行
durably.start()               // ワーカーを開始
await durably.stop()          // ワーカーを正常に停止

// ジョブ管理
const job = durably.register(defineJob(options, handler)
await durably.retry(runId)    // 失敗した実行をリトライ

// イベント
const unsub = durably.on(event, handler)
```

### ジョブメソッド

```ts
const job = durably.register(defineJob(...)

// 新しい実行をトリガー
await job.trigger(input, options?)
```

### ステップメソッド

```ts
durably.register(defineJob(..., async (step, payload) => {
  // ステップを実行
  const result = await step.run('step-name', async () => {
    return value
  })

  // メッセージをログ
  step.log.info('message', { data })
})
```

## 型エクスポート

```ts
import type {
  Durably,
  DurablyOptions,
  Job,
  JobOptions,
  StepContext,
  TriggerOptions,
  RunStatus,
  StepStatus,
} from '@coji/durably'
```
