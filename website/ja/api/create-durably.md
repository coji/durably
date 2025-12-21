# createDurably

新しいDurablyインスタンスを作成します。

## シグネチャ

```ts
function createDurably(options: DurablyOptions): Durably
```

## オプション

```ts
interface DurablyOptions {
  dialect: Dialect
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
}
```

| オプション | 型 | デフォルト | 説明 |
|--------|------|---------|-------------|
| `dialect` | `Dialect` | 必須 | Kysely SQLiteダイアレクト |
| `pollingInterval` | `number` | `1000` | 保留中のジョブをチェックする頻度（ミリ秒） |
| `heartbeatInterval` | `number` | `5000` | ハートビートを更新する頻度（ミリ秒） |
| `staleThreshold` | `number` | `30000` | ジョブが失効とみなされるまでの時間（ミリ秒） |

## 戻り値

以下のメソッドを持つ`Durably`インスタンスを返します：

### `migrate()`

```ts
await durably.migrate(): Promise<void>
```

必要なテーブルを作成するためのデータベースマイグレーションを実行します。

### `start()`

```ts
durably.start(): void
```

保留中のジョブを処理するワーカーを開始します。

### `stop()`

```ts
await durably.stop(): Promise<void>
```

現在のジョブが完了するのを待って、ワーカーを正常に停止します。

### `defineJob()`

```ts
durably.defineJob<I, O>(
  options: JobOptions<I, O>,
  handler: JobHandler<I, O>
): Job<I, O>
```

新しいジョブを定義します。詳細は[defineJob](/ja/api/define-job)を参照してください。

### `on()`

```ts
durably.on<E extends EventType>(
  event: E,
  handler: EventHandler<E>
): () => void
```

イベントを購読します。購読解除関数を返します。[イベント](/ja/api/events)を参照してください。

### `retry()`

```ts
await durably.retry(runId: string): Promise<void>
```

失敗した実行のステータスを保留中にリセットしてリトライします。

## 例

```ts
import { createDurably } from '@coji/durably'
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({
  dialect,
  pollingInterval: 1000,
  heartbeatInterval: 5000,
  staleThreshold: 30000,
})

await durably.migrate()
durably.start()

// ジョブを定義...
const myJob = durably.defineJob(...)

// クリーンシャットダウン
process.on('SIGTERM', async () => {
  await durably.stop()
})
```
