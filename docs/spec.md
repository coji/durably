# durably 仕様書

## Why：なぜこれを作るのか

この仕組みは、Node.js およびブラウザ環境において、途中で中断しても再開できるバッチ処理を、最小の依存で実現するために作る。

既存の選択肢として、Redis を前提とした BullMQ、専用クラスタを必要とする Temporal、専用ランタイムを伴う DBOS や Trigger.dev などがある。しかしこれらは Node.js サーバー環境を前提としており、ブラウザでは動作しない。また、小〜中規模のアプリケーションにとっては過剰な構成を要求する。

必要なのは、Node.js でもブラウザでも同じ API で動作し、外部サービスに依存せず、SQLite だけで完結する最小構成である。Node.js では Turso/libSQL を、ブラウザでは SQLite WASM（OPFS バックエンド）を使うことで、同一のジョブ定義コードがどちらの環境でも実行できる。

この仕組みが目指すのは、分散ワークフローエンジンではない。cron のような時間駆動、Webhook 購読、Fan-out、複雑な再試行戦略は、すべてスコープ外である。ステップ単位で状態を永続化し、プロセスやページの再起動によって自動的に復旧する、それだけに特化した実行基盤を作る。

DX としては、ジョブ定義が純粋な TypeScript 関数であること、型安全であること、環境ごとの分岐コードを書かなくてよいことを重視する。運用としては、設定項目が少なく、状態がデータベースを見れば分かり、トラブル時の対処が明確であることを重視する。また、将来的に UI で実行履歴やエラーを確認できるよう、イベントとログの仕組みを最初から備えておく。

---

## パッケージ構成

npm パッケージ名は `@coji/durably` スコープを使用する。将来的にフレームワーク統合などのサブパッケージを追加する際は、同じスコープ内で `@coji/durably-react`、`@coji/durably-vue` のような命名規則を採用する。

| パッケージ | 説明 |
|-----------|------|
| `@coji/durably` | コアライブラリ |
| `@coji/durably-react` | React 統合（将来） |
| `@coji/durably-vue` | Vue 統合（将来） |

---

## What：これは何なのか

これは、Node.js およびブラウザで動作する、ステップ指向のバッチ実行基盤である。

### コア概念

Durably は 4 つの概念で構成される。

```txt
Durably (インスタンス)
  └── Job (ジョブ定義)
        └── Run (実行インスタンス)
              └── Step (処理単位)
```

**Durably** はライブラリのインスタンスである。ジョブの定義、ワーカーの起動、データベースへのアクセスを担う。

**Job** は「何をするか」の定義である。名前、入力スキーマ、出力スキーマ、処理関数を持つ。Job 自体は状態を持たず、何度でも実行できるテンプレートとして機能する。

**Run** は Job の実行インスタンスである。`trigger()` によって作成され、pending → running → completed/failed と状態遷移する。すべての Run はデータベースに永続化される。

**Step** は Run 内の処理単位である。`ctx.run()` によって定義され、成功すると戻り値がデータベースに保存される。Run が中断・再開された場合、成功済みの Step はスキップされ、保存済みの戻り値が返される。

### ジョブとステップ

ジョブは `durably.defineJob` メソッドによって定義される。ジョブは名前、入力スキーマ、出力スキーマ、処理関数を持つ。スキーマは Zod v4 で定義し、入出力の型安全性を保証する。

```ts
import { createDurably } from '@coji/durably'
import { z } from 'zod'

const durably = createDurably({ dialect })

const syncUsers = durably.defineJob({
  name: "sync-users",
  input: z.object({
    orgId: z.string(),
    force: z.boolean().optional(),
  }),
  output: z.object({
    syncedCount: z.number(),
    skippedCount: z.number(),
  }),
}, async (ctx, payload) => {
  // payload は { orgId: string, force?: boolean } として型推論される

  const users = await ctx.run("fetch-users", async () => {
    return api.fetchUsers(payload.orgId)
  })

  await ctx.run("save-to-db", async () => {
    await db.upsertUsers(users)
  })

  // 戻り値は output スキーマで検証される
  return { syncedCount: users.length, skippedCount: 0 }
})
```

`defineJob` を呼び出した時点でジョブは登録される。`defineJob` は以下の型を持つ `JobHandle` を返す。

```ts
interface JobHandle<TName extends string, TInput, TOutput> {
  readonly name: TName
  trigger(input: TInput, options?: TriggerOptions): Promise<Run<TOutput>>
  triggerAndWait(input: TInput, options?: TriggerOptions): Promise<{ id: string; output: TOutput }>
  batchTrigger(inputs: BatchTriggerInput<TInput>[]): Promise<Run<TOutput>[]>
  getRun(id: string): Promise<Run<TOutput> | null>
  getRuns(filter?: RunFilter): Promise<Run<TOutput>[]>
}

interface TriggerOptions {
  idempotencyKey?: string
  concurrencyKey?: string
}

interface RunFilter {
  status?: 'pending' | 'running' | 'completed' | 'failed'
  jobName?: string
}
```

`TInput` と `TOutput` は Zod スキーマから推論される。これにより `trigger` の引数に対してエディタ補完が効き、型チェックも行われる。

入力は `trigger` 時に検証され、不正な場合は例外が発生する。出力はジョブ関数の戻り値として返し、完了時に検証されて Run に保存される。出力の検証に失敗した場合、Run は `failed` 状態となり、エラー詳細が記録される。

`ctx.run` に渡す名前は、同一 Run 内で一意でなければならない。同じ名前のステップが複数回実行された場合はエラーとなる。成功したステップは再実行時に自動的にスキップされ、保存済みの戻り値が返される。この挙動は固定であり、ユーザーが選択する必要はない。

`ctx.run` の戻り値はステップ関数の戻り値から型推論される。

```ts
// users は User[] 型として推論される
const users = await ctx.run("fetch-users", async () => {
  return api.fetchUsers(payload.orgId)  // User[] を返す
})

// 明示的に型パラメータを指定することも可能
const count = await ctx.run<number>("count", async () => {
  return someExternalApi()
})
```

このコードは Node.js でもブラウザでもそのまま動作する。環境の違いは `createDurably` に渡す Kysely dialect によって吸収される。

### Run とトリガー

ジョブの実行単位は Run と呼ばれる。Run は `trigger` 関数によって作成され、必ず一度 `pending` 状態としてデータベースに永続化されてから実行される。

```ts
await syncUsers.trigger({ orgId: "org_123" })
```

`trigger` は Run の作成だけを行い、実行の完了を待たない。Run の実行はワーカーが非同期に行う。`trigger` は作成された Run オブジェクトを返す。

```ts
const run = await syncUsers.trigger({ orgId: "org_123" })
console.log(run.id)     // Run の ID
console.log(run.status) // "pending"
```

### 重複排除と直列化

`trigger` には二種類のオプションキーを指定できる。

`idempotencyKey` は、同一イベントの二重登録を防ぐためのキーである。同じジョブ名と `idempotencyKey` の組み合わせがすでに存在する場合、新しい Run は作成されず、既存の Run が返される。`idempotencyKey` の有効期限は設けず、Run が存在する限り重複排除が機能する。古い Run を削除すれば同じキーで再登録が可能になる。

```ts
await syncUsers.trigger(
  { orgId: "org_123" },
  { idempotencyKey: "webhook-event-456" }
)
```

`concurrencyKey` は、同一対象への同時処理を防ぐためのキーである。同じ `concurrencyKey` を持つ Run が実行中の場合、後続の Run は実行待ちになる。ただし Run の作成自体はキャンセルされない。

```ts
await syncUsers.trigger(
  { orgId: "org_123" },
  { concurrencyKey: "org_123" }
)
```

この二つは独立した概念であり、両方を同時に指定することもできる。

### バッチ登録

複数の `trigger` を一度にまとめて登録したい場合は `batchTrigger` を使う。これは単に複数の Run を同一トランザクションで一括登録するための API であり、実行モデルには影響しない。

```ts
await syncUsers.batchTrigger([
  { payload: { orgId: "org_1" }, options: { idempotencyKey: "event-1" } },
  { payload: { orgId: "org_2" }, options: { idempotencyKey: "event-2" } },
])
```

### Run の状態

Run は以下の状態を持つ。

`pending` は実行待ちの状態である。ワーカーによって取得されるのを待っている。`concurrencyKey` によってブロックされている Run も、状態としては `pending` のままである。

`running` は実行中の状態である。ワーカーが Run を取得し、ステップを実行している。

`completed` は正常完了の状態である。すべてのステップが成功し、ジョブ関数が正常に終了した。

`failed` は失敗の状態である。いずれかのステップで例外が発生し、Run が中断された。

状態遷移は `pending → running → completed` または `pending → running → failed` のいずれかである。一度 `completed` または `failed` になった Run は、自動では再実行されない。

### 失敗と再実行

ステップが例外を投げた場合、その Run は即座に `failed` になる。自動リトライは行われない。これは意図的な設計であり、リトライ戦略をライブラリが暗黙に決めることを避けている。

失敗した Run を再実行したい場合は、同じ `idempotencyKey` を使わずに新しい `trigger` を発行するか、`retry` API を使って明示的に再実行する。

```ts
await durably.retry(runId)
```

`retry` は `failed` 状態の Run を `pending` に戻し、ワーカーによる再取得を可能にする。再実行時には、成功済みのステップはスキップされる。

### Run の取得

Run の状態を確認するための API を提供する。Run の取得には2つの方法がある。

#### JobHandle 経由（型安全）

アプリケーションコードで特定のジョブの Run を取得する場合は、JobHandle のメソッドを使う。`output` は Zod スキーマから推論された型になる。

```ts
// trigger の戻り値から ID を保存しておく
const run = await syncUsers.trigger({ orgId: "org_123" })
saveToSession(run.id)

// 後で結果を取得（output は型安全）
const run = await syncUsers.getRun(getFromSession())
if (run?.status === 'completed') {
  console.log(run.output.syncedCount)  // number 型として補完される
}

// このジョブの失敗した Run を取得
const failedRuns = await syncUsers.getRuns({ status: 'failed' })
```

#### durably 経由（横断的）

管理画面やデバッグで全ジョブを横断的に取得する場合は、durably のメソッドを使う。`output` は `unknown` 型になる。

```ts
// 全ジョブの失敗した Run を取得
const failedRuns = await durably.getRuns({ status: 'failed' })
for (const run of failedRuns) {
  console.log(run.jobName, run.error)
}

// ジョブ名でフィルタ
const runs = await durably.getRuns({ jobName: 'sync-users' })

// 特定の Run を取得（どのジョブかわからない場合）
const run = await durably.getRun(runId)
if (run?.status === 'completed') {
  console.log(run.output)  // unknown 型
}
```

`getRun` は指定した ID の Run を返す。存在しない場合は `null` を返す。`getRuns` はフィルタ条件に一致する Run の配列を返す。条件を指定しない場合は全件を返す。結果は `created_at` の降順でソートされる。

v1 ではページネーションは提供しない。大量の Run がある場合は `status` や `jobName` でフィルタするか、アプリケーション側で Run の削除を行って管理する。将来的に `limit` と `cursor` オプションを追加する可能性がある。

### ワーカー

ワーカーは `start` 関数によって起動される。起動すると、一定間隔で `pending` 状態の Run を取得し、逐次実行する。

```ts
import { createDurably } from '@coji/durably'
import { z } from 'zod'

const durably = createDurably({ dialect })

const syncUsers = durably.defineJob({
  name: "sync-users",
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
}, async (ctx, payload) => {
  // ...
  return { syncedCount: 0 }
})

await durably.migrate()
durably.start()
```

ワーカーは常に一件ずつ Run を処理する。最小構成では並列実行は行わない。`concurrencyKey` による直列化は、Run 取得時のクエリで制御される。同じ `concurrencyKey` を持つ別の Run が `running` 状態であれば、その Run は取得対象から除外される。

ワーカーは `running` 状態の Run に対して、一定間隔で heartbeat を更新する。プロセスが異常終了した場合、heartbeat が更新されなくなった Run は、次に起動したワーカーによって回収され、自動的に再実行される。

ワーカーを停止したい場合は `stop` を呼ぶ。これは現在実行中の Run の完了を待ってからワーカーを停止する。

```ts
await durably.stop()
```

### 初期化

データベーステーブルの作成は、明示的な `migrate` 関数によって行う。

```ts
await durably.migrate()
```

この関数は冪等であり、何度呼んでも安全である。アプリケーション起動時またはページロード時に呼ぶことを想定している。スキーマのバージョン管理はライブラリ内部で行われ、将来のバージョンアップ時には自動的にマイグレーションが適用される。

### イベントシステム

ライブラリ内部で起きたことを外部に通知するためのイベントシステムを持つ。これにより、ログの永続化、外部サービスへの送信、リアルタイム UI 更新など、任意の処理を接続できる。

```ts
durably.on('run:start', (event) => {
  // { runId, jobName, payload, timestamp }
})

durably.on('run:complete', (event) => {
  // { runId, jobName, output, duration, timestamp }
})

durably.on('run:fail', (event) => {
  // { runId, jobName, error, failedStepName, timestamp }
})

durably.on('step:start', (event) => {
  // { runId, jobName, stepName, stepIndex, timestamp }
})

durably.on('step:complete', (event) => {
  // { runId, jobName, stepName, stepIndex, duration, output, timestamp }
})

durably.on('step:fail', (event) => {
  // { runId, jobName, stepName, stepIndex, error, timestamp }
})
```

イベントは同期的に発火される。リスナー内で例外が発生しても、Run の実行には影響しない。

#### イベント型定義

すべてのイベントは Discriminated Union として定義される。各イベントには共通フィールドとして `type` と `timestamp` が含まれ、`sequence` フィールドで順序が保証される。

```ts
// 基本イベント型
interface BaseEvent {
  type: string
  timestamp: string
  sequence: number  // イベントの順序番号
}

// Run イベント
interface RunStartEvent extends BaseEvent {
  type: 'run:start'
  runId: string
  jobName: string
  payload: unknown
}

interface RunCompleteEvent extends BaseEvent {
  type: 'run:complete'
  runId: string
  jobName: string
  output: unknown
  duration: number
}

interface RunFailEvent extends BaseEvent {
  type: 'run:fail'
  runId: string
  jobName: string
  error: string
  failedStepName: string
}

// Step イベント
interface StepStartEvent extends BaseEvent {
  type: 'step:start'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
}

interface StepCompleteEvent extends BaseEvent {
  type: 'step:complete'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  output: unknown
  duration: number
}

interface StepFailEvent extends BaseEvent {
  type: 'step:fail'
  runId: string
  jobName: string
  stepName: string
  stepIndex: number
  error: string
}

// Log イベント
interface LogWriteEvent extends BaseEvent {
  type: 'log:write'
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
}

// 全イベントの Union 型
type DurablyEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
```

この型定義により、将来的なイベント型の追加（例: `stream` イベント）が容易になる。

### 進捗管理

ジョブの進捗状況を外部から確認できるようにするための API を提供する。

```ts
const syncUsers = durably.defineJob({
  name: "sync-users",
  input: z.object({ orgId: z.string() }),
  output: z.object({ processedCount: z.number() }),
}, async (ctx, payload) => {
  ctx.progress(0, 100, "Starting...")

  const users = await ctx.run("fetch-users", async () => {
    const result = await api.fetchUsers(payload.orgId)
    ctx.progress(10, 100, "Fetched users")
    return result
  })

  for (let i = 0; i < users.length; i++) {
    await ctx.run(`process-user-${users[i].id}`, async () => {
      await processUser(users[i])
    })
    ctx.progress(10 + ((i + 1) / users.length) * 90)
  }

  return { processedCount: users.length }
})
```

`ctx.progress(current, total?, message?)` は進捗情報を Run に保存する。`current` は必須、`total` と `message` は任意である。

進捗は `getRun` で取得できる。

```ts
const run = await durably.getRun(runId)
console.log(run.progress) // { current: 45, total: 100, message: "Fetched users" }
```

進捗情報は Run が再開された場合も保持される。Step の成功・失敗とは独立して管理され、UI での進捗表示に使用できる。

### 構造化ログ

ジョブ内から明示的にログを残すための API を提供する。ログは Run に紐づけられ、後から UI で確認できる。

```ts
const syncUsers = durably.defineJob({
  name: "sync-users",
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
}, async (ctx, payload) => {
  ctx.log.info("starting sync", { orgId: payload.orgId })

  const users = await ctx.run("fetch-users", async () => {
    const result = await api.fetchUsers(payload.orgId)
    ctx.log.info("fetched users", { count: result.length })
    return result
  })

  if (users.length === 0) {
    ctx.log.warn("no users found")
  }

  return { syncedCount: users.length }
})
```

ログレベルは `info`、`warn`、`error` の三種類である。各ログには任意の構造化データを付与できる。

ログは `log:write` イベントとして発火される。

```ts
durably.on('log:write', (event) => {
  // { runId, stepName, level, message, data, timestamp }
})
```

### プラグインシステム

イベントを活用した拡張をプラグインとして提供する。プラグインは `use` メソッドで登録する。

```ts
import { createDurably } from '@coji/durably'
import { withLogPersistence } from '@coji/durably/plugins'

const durably = createDurably({ dialect })
durably.use(withLogPersistence())
```

コアライブラリに同梱するプラグインは以下の通りである。

`withLogPersistence()` はすべてのイベントとログをデータベースに永続化する。UI での履歴表示に必要となる。

```ts
durably.use(withLogPersistence())
```

このプラグインを有効にすると、logs テーブルにデータが書き込まれる。プラグインを使わない場合、logs テーブルは空のままであり、ストレージを消費しない。

将来的に `withRetry()`、`withTimeout()`、`withSentryIntegration()` などのプラグインを追加できる設計とする。

---

## How：どのように実現するのか

### 構成

実装はシングルスレッドの JavaScript 実行環境と SQLite のみで構成される。すべてのクエリは Kysely を通じて発行される。Kysely を選択する理由は、型安全な SQL ビルダーであること、dialect の差し替えによって複数の SQLite 実装に対応できること、ORM ではなくクエリビルダーであるため挙動が予測しやすいことである。

### 環境ごとの dialect

このライブラリは Kysely の dialect を外部から受け取る設計とし、環境ごとの SQLite 実装の違いを吸収する。

Node.js 環境では Turso/libSQL を推奨する。ローカル開発では `file:` スキーマでローカルファイルを使用し、本番では Turso のクラウドデータベースに接続できる。

```ts
import { LibsqlDialect } from '@libsql/kysely-libsql'

const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})
const durably = createDurably({ dialect })
```

ブラウザ環境では SQLocal を使用する。SQLocal は SQLite WASM を Web Worker で実行し、OPFS による永続化を自動的に行う。Kysely 用の dialect も提供されている。

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect } = new SQLocalKysely('durably.sqlite3')
const durably = createDurably({ dialect })
```

Vite を使用する場合は、SQLocal の Vite プラグインを追加すると、開発サーバーでの COOP/COEP ヘッダー設定が自動化される。

ライブラリ本体は dialect の具体的な実装に依存せず、Kysely のインターフェースのみを使用する。これにより、将来的に Postgres や MySQL に対応する場合も、同じ設計で拡張できる。

### ブラウザ環境の制約

ブラウザ環境には Node.js とは異なる制約がある。この仕様ではそれらを制約として明記し、ライブラリが無理に解決しようとしない方針を取る。

**タブのライフサイクル**: ブラウザではタブが閉じられると処理が中断される。これは Node.js でプロセスが終了するのと同じ扱いであり、次回タブを開いた際に heartbeat 切れの Run が回収されて再実行される。

**バックグラウンド制限**: ブラウザはバックグラウンドタブでの実行を制限する場合がある。長時間かかるステップがバックグラウンドで中断された場合も、heartbeat 切れとして回収される。これを避けたい場合は、ステップを細かく分割するか、Service Worker での実行を検討する。

**複数タブ**: SQLocal はタブ間でのデータベース変更通知をサポートしているが、このライブラリでは単一タブでのワーカー実行を前提とする。複数タブで同時にワーカーを起動すると、同じ Run を複数回実行する可能性がある。複数タブで使いたい場合は SharedWorker を介するか、タブ間でリーダー選出を行う必要があるが、それはアプリケーション側の責務である。

**OPFS の要件**: OPFS は Secure Context（HTTPS または localhost）でのみ使用可能である。SQLocal は内部的に Web Worker を使用して OPFS への同期アクセスを処理するため、アプリケーション側で Worker を意識する必要はない。

### スキーマ

以下の論理スキーマを仕様として固定する。Kysely による DDL はこの仕様の実装であり、スキーマの正は仕様側にある。

**runs テーブル**

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (ULID) | Run の一意識別子 |
| job_name | TEXT | ジョブ名 |
| payload | TEXT (JSON) | ジョブに渡される引数 |
| status | TEXT | pending / running / completed / failed |
| idempotency_key | TEXT (nullable) | 重複排除キー |
| concurrency_key | TEXT (nullable) | 直列化キー |
| current_step_index | INTEGER | 次に実行すべきステップのインデックス |
| progress | TEXT (JSON, nullable) | 進捗情報 { current, total, message } |
| output | TEXT (JSON, nullable) | ジョブの出力（completed 時のみ） |
| error | TEXT (nullable) | 失敗時のエラーメッセージ |
| heartbeat_at | TEXT (ISO8601) | 最終 heartbeat 時刻 |
| created_at | TEXT (ISO8601) | 作成時刻 |
| updated_at | TEXT (ISO8601) | 最終更新時刻 |

**steps テーブル**

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (ULID) | Step の一意識別子 |
| run_id | TEXT | 所属する Run の ID |
| name | TEXT | ステップ名 |
| index | INTEGER | 実行順序 |
| status | TEXT | completed / failed |
| output | TEXT (JSON, nullable) | ステップの戻り値 |
| error | TEXT (nullable) | 失敗時のエラーメッセージ |
| started_at | TEXT (ISO8601) | 開始時刻 |
| completed_at | TEXT (ISO8601, nullable) | 完了時刻 |

**logs テーブル**

| カラム | 型 | 説明 |
|--------|------|------|
| id | TEXT (ULID) | ログの一意識別子 |
| run_id | TEXT | 所属する Run の ID |
| step_name | TEXT (nullable) | ステップ名（ステップ外のログは null） |
| level | TEXT | info / warn / error |
| message | TEXT | ログメッセージ |
| data | TEXT (JSON, nullable) | 追加データ |
| timestamp | TEXT (ISO8601) | 発生時刻 |

**schema_versions テーブル**

| カラム | 型 | 説明 |
|--------|------|------|
| version | INTEGER | 適用済みのスキーマバージョン |
| applied_at | TEXT (ISO8601) | 適用時刻 |

**インデックス**

- `runs`: `(job_name, idempotency_key)` の複合ユニーク制約
- `runs`: `(status, concurrency_key)` の複合インデックス
- `runs`: `(status, created_at)` の複合インデックス
- `steps`: `(run_id, index)` の複合インデックス
- `logs`: `(run_id, created_at)` の複合インデックス

**ULID の実装**: ID 生成には ULID（Universally Unique Lexicographically Sortable Identifier）を使用する。実装は軽量な `ulidx` パッケージを採用し、ブラウザと Node.js の両方で動作する。ULID はタイムスタンプを含むためソート可能であり、UUID と同等のユニーク性を持つ。

### ワーカーの動作

ワーカーはポーリングベースで動作する。Node.js では `setInterval`、ブラウザでも `setInterval` を使用する。デフォルトのポーリング間隔は 1000 ミリ秒であり、設定で変更できる。

Run の取得クエリは以下の条件を満たすものを一件取得する。`status` が `pending` であること。`concurrency_key` が null であるか、同じ `concurrency_key` を持つ `running` 状態の Run が存在しないこと。`created_at` が最も古いものを優先すること。

取得した Run は即座に `running` に更新され、`run:start` イベントが発火される。その後ステップの実行が開始される。各ステップの実行開始時に `step:start` イベントが発火され、`heartbeat_at` が更新される。ステップが成功すると、steps テーブルにレコードが挿入され、`step:complete` イベントが発火され、`current_step_index` がインクリメントされる。

すべてのステップが完了すると、Run は `completed` に更新され、`run:complete` イベントが発火される。いずれかのステップで例外が発生すると、steps テーブルに失敗レコードが挿入され、`step:fail` イベントが発火され、Run は `failed` に更新され、`run:fail` イベントが発火される。

### 再開時の挙動

ワーカー起動時に、`running` 状態かつ `heartbeat_at` が閾値より古い Run が存在する場合、それは前プロセスまたは前タブの異常終了とみなされる。該当する Run は `pending` に戻され、通常の取得対象に含まれる。

再実行時には、steps テーブルを参照し、`status` が `completed` かつ `index` が `current_step_index` より小さいステップはスキップされる。`ctx.run` が呼ばれた時点で、該当するステップがすでに成功していれば、保存済みの `output` がそのまま返される。

### heartbeat

ワーカーは Run の実行中、一定間隔で `heartbeat_at` を更新する。デフォルトの間隔は 5000 ミリ秒であり、設定で変更できる。heartbeat の更新は、現在実行中のステップとは非同期に行われる。

回収閾値のデフォルトは 30000 ミリ秒である。これは heartbeat 間隔の 6 倍に相当し、一時的なプロセス停止や GC による遅延を許容しつつ、異常終了を合理的な時間で検知できる値として設定されている。

ブラウザ環境でバックグラウンドタブになった場合、`setInterval` の実行間隔が延長される可能性がある。この場合 heartbeat が更新されず、Run が回収対象になることがある。これは意図した挙動であり、バックグラウンドで中断された処理は次回フォアグラウンドになった際に再開される。

### イベント発火タイミング

| イベント | 発火タイミング |
|----------|----------------|
| run:start | Run が running に遷移した直後 |
| run:complete | Run が completed に遷移した直後 |
| run:fail | Run が failed に遷移した直後 |
| step:start | ステップの実行を開始する直前 |
| step:complete | ステップが成功し DB に記録した直後 |
| step:fail | ステップが失敗し DB に記録した直後 |
| log:write | ctx.log が呼ばれた直後 |

### 設定項目

`createDurably` に渡せる設定は以下の通りである。

| 項目 | デフォルト | 説明 |
|------|------------|------|
| dialect | (必須) | Kysely dialect |
| pollingInterval | 1000 | Run 取得のポーリング間隔（ミリ秒） |
| heartbeatInterval | 5000 | heartbeat 更新間隔（ミリ秒） |
| staleThreshold | 30000 | 回収対象とみなす heartbeat 経過時間（ミリ秒） |

設定項目は意図的に最小限に抑えている。調整が必要になるのは、長時間かかるステップがある場合に `staleThreshold` を伸ばすケースがほとんどである。

### 依存関係とインストール

ライブラリは単一パッケージとして提供し、環境固有の dialect は含めない。ユーザーは自身の環境に合わせて Kysely と dialect を別途インストールする。

```txt
@coji/durably         # コアライブラリ（環境非依存）
├── kysely            # peer dependency
├── zod               # peer dependency
```

Node.js で使う場合（Turso/libSQL）：
```sh
npm install @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

ブラウザで使う場合：
```sh
npm install @coji/durably kysely zod sqlocal
```

プラグインはコアパッケージに同梱し、サブパスからインポートする。

```ts
import { withLogPersistence } from '@coji/durably/plugins'
```

UI は将来的に別パッケージ（`@coji/durably-ui`）として提供し、logs テーブルと runs/steps テーブルを読み取って実行履歴を表示する。

---

## 使用例

### 基本的な使い方

```ts
import { createDurably } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

// dialect の設定（Turso/libSQL）
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:app.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

// インスタンスの作成
const durably = createDurably({ dialect })

// ジョブの定義（定義時に自動登録される）
const syncUsers = durably.defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
}, async (ctx, payload) => {
  ctx.log.info('starting sync', { orgId: payload.orgId })

  const users = await ctx.run('fetch-users', async () => {
    const result = await api.fetchUsers(payload.orgId)
    ctx.log.info('fetched users', { count: result.length })
    return result
  })

  await ctx.run('save-to-db', async () => {
    await db.upsertUsers(users)
  })

  ctx.log.info('sync completed')
  return { syncedCount: users.length }
})

// マイグレーションの実行
await durably.migrate()

// ワーカーの起動
durably.start()

// ジョブのトリガー
await syncUsers.trigger({ orgId: 'org_123' })
```

### イベントの購読

```ts
durably.on('run:start', (event) => {
  console.log(`Run started: ${event.runId}`)
})

durably.on('run:fail', (event) => {
  console.error(`Run failed: ${event.runId}`, event.error)
  // 外部の監視サービスに通知するなど
})

durably.on('step:complete', (event) => {
  console.log(`Step completed: ${event.stepName} in ${event.duration}ms`)
})
```

### ログの永続化

```ts
import { createDurably } from '@coji/durably'
import { withLogPersistence } from '@coji/durably/plugins'

const durably = createDurably({ dialect })
durably.use(withLogPersistence())
```

### 失敗した Run の再実行

```ts
// 失敗した Run を取得
const failedRuns = await durably.getRuns({ status: 'failed' })

// 再実行
for (const run of failedRuns) {
  await durably.retry(run.id)
}
```

---

## 内部設計指針

この仕様は v1 として完結しているが、将来的な拡張（v2: AI Agent/ストリーミング対応）を見据えた設計指針を示す。実装時にはこれらの指針に従うことで、破壊的変更を最小限に抑えつつ機能拡張が可能になる。

### JobContext の設計

`JobContext` はクラスまたはファクトリ関数として実装し、メソッド追加が容易な構造にする。

```ts
// 推奨される実装パターン
class JobContextImpl<TPayload> implements JobContext<TPayload> {
  constructor(
    private runId: string,
    private emitter: EventEmitter,
    private storage: Storage,
  ) {}

  async run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    // 実装
  }

  log = {
    info: (message: string, data?: unknown) => this.writeLog('info', message, data),
    warn: (message: string, data?: unknown) => this.writeLog('warn', message, data),
    error: (message: string, data?: unknown) => this.writeLog('error', message, data),
  }

  setProgress(progress: Progress): void {
    // 実装
  }

  private writeLog(level: LogLevel, message: string, data?: unknown): void {
    // 実装
  }

  // v2 で追加予定:
  // async stream<T>(name: string, fn: (emit: EmitFn) => Promise<T>): Promise<T>
}
```

内部で `EventEmitter` を保持し、イベントの emit を一元化する。これにより v2 で `stream` イベントを追加する際も、同じ emit 機構を利用できる。

### Storage 層の抽象化

データベース操作は Storage インターフェースとして抽象化し、将来のテーブル追加に備える。

```ts
interface Storage {
  // Run 操作
  createRun(run: Run): Promise<void>
  updateRun(runId: string, data: Partial<Run>): Promise<void>
  getRun(runId: string): Promise<Run | null>
  getRuns(filter?: RunFilter): Promise<Run[]>
  getNextPendingRun(excludeConcurrencyKeys: string[]): Promise<Run | null>

  // Step 操作
  createStep(step: Step): Promise<void>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>

  // Log 操作（withLogPersistence プラグイン用）
  createLog?(log: Log): Promise<void>
  getLogs?(runId: string): Promise<Log[]>

  // v2 で追加予定:
  // createEvent?(event: DurablyEvent): Promise<void>
  // getEvents?(runId: string, afterSequence?: number): Promise<DurablyEvent[]>
}
```

### イベントシーケンス

イベントには `sequence` フィールドを含め、順序を保証する。v1 ではインメモリでのインクリメントで十分だが、v2 では DB 永続化時にこの値が重要になる。

```ts
class EventEmitter {
  private sequence = 0

  emit(event: Omit<DurablyEvent, 'sequence' | 'timestamp'>): void {
    const fullEvent = {
      ...event,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
    }
    // リスナーに配信
  }
}
```

---

## 将来拡張への準備（v2 参照）

v2 では AI Agent ワークフロー対応として以下の機能が計画されている。詳細は [future-spec-ai-agent.md](./future-spec-ai-agent.md) を参照。

### 計画されている機能

| 機能 | 概要 |
|------|------|
| `ctx.stream()` | ストリーミング出力をサポートするステップ |
| `subscribe()` | Run の実行をリアルタイムで購読（ReadableStream） |
| `events` テーブル | 粗いイベント（step:*, run:*）の永続化 |
| `checkpoint()` | 長時間実行中の中間状態保存 |

### v1 での準備事項

v1 実装時に以下を守ることで、v2 への移行がスムーズになる。

1. **イベント型は Discriminated Union で定義する**
   - `type` フィールドで識別可能にする
   - `sequence` フィールドを含める

2. **JobContext はクラス/ファクトリで実装する**
   - メソッド追加が容易な構造にする
   - 内部で EventEmitter を保持する

3. **Storage 層を抽象化する**
   - インターフェースを定義し、実装を分離する
   - 将来のテーブル追加に備える

4. **runs テーブルの sequence カラム（任意）**
   - v2 でイベント永続化を行う際に有用
   - v1 では使用しないが、スキーマに含めておくとマイグレーションが不要

```sql
-- 任意: v2 に備えて追加
ALTER TABLE runs ADD COLUMN last_event_sequence INTEGER DEFAULT 0;
```

---

この仕様により、Node.js でもブラウザでも同じジョブ定義コードが動作し、状態はすべて SQLite に集約され、プロセスやタブの再起動だけで自動復旧する実行基盤が実現される。イベントとログの仕組みにより、将来的な UI 連携や外部サービス統合も可能となる。
