# @coji/durably-react 仕様書

## 概要

`@coji/durably-react` は、Durably を React アプリケーションで使うためのバインディングである。

以下の2つの動作モードをサポートする:

| モード | 説明 | サーバー | クライアント |
|--------|------|----------|--------------|
| **ブラウザ完結** | ブラウザ内で Durably を実行 | 不要 | `@coji/durably-react` + `@coji/durably` |
| **サーバー連携** | サーバーで Durably を実行、クライアントで購読 | `@coji/durably` | `@coji/durably-react/client`（軽量） |

---

## パッケージ構成

```text
@coji/durably-react
├── index.ts          # ブラウザ完結モード用（DurablyProvider + hooks）
└── client/index.ts   # サーバー連携モード用（軽量、@coji/durably 不要）

@coji/durably
└── server.ts         # サーバー側ヘルパー（Web 標準 API）
```

---

## パターン A: ブラウザ完結モード

ブラウザ内で SQLite（OPFS）を使い、Durably を完全にクライアントサイドで実行する。

### セットアップ

Durably インスタンスは Promise として export し、DurablyProvider に直接渡す:

```ts
// lib/durably.ts
import { createDurably, type Durably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { processImageJob } from './jobs'

export { processImageJob }

export const sqlocal = new SQLocalKysely('app.sqlite3')

async function initDurably(): Promise<Durably> {
  const instance = createDurably({
    dialect: sqlocal.dialect,
    pollingInterval: 100,
    heartbeatInterval: 500,
    staleThreshold: 3000,
  })
  await instance.migrate()
  instance.register({ processImage: processImageJob })
  return instance
}

/** Shared Durably instance promise */
export const durably = initDurably()
```

```tsx
// App.tsx
import { DurablyProvider } from '@coji/durably-react'
import { durably } from './lib/durably'

function Loading() {
  return <div>Loading...</div>
}

export function App() {
  return (
    <DurablyProvider durably={durably} fallback={<Loading />}>
      <AppContent />
    </DurablyProvider>
  )
}
```

`DurablyProvider` は `Durably` または `Promise<Durably>` を受け付ける。Promise の場合は内部で React 19 の `use()` を使って解決する。`fallback` を指定すると自動的に Suspense でラップされる。

React Router 7 の場合は `clientLoader` を使用することもできる:

```tsx
// root.tsx
import { DurablyProvider } from '@coji/durably-react'
import { Outlet } from 'react-router'
import { getDurably } from './lib/durably'

export async function clientLoader() {
  const durably = await getDurably()
  return { durably }
}

export function HydrateFallback() {
  return <div>Loading...</div>
}

export default function App({ loaderData }) {
  return (
    <DurablyProvider durably={loaderData.durably}>
      <Outlet />
    </DurablyProvider>
  )
}
```

### ジョブ定義

```ts
// jobs.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const processTask = defineJob({
  name: 'process-task',
  input: z.object({ taskId: z.string() }),
  output: z.object({ success: z.boolean() }),
  run: async (step, payload) => {
    await step.run('validate', () => validate(payload.taskId))
    step.progress(1, 2, 'Validating...')
    await step.run('process', () => process(payload.taskId))
    step.progress(2, 2, 'Processing...')
    return { success: true }
  },
})
```

### 使用

```tsx
// component.tsx
import { useJob } from '@coji/durably-react'
import { processTask } from './jobs'

function TaskRunner() {
  const { trigger, status, output, progress, isRunning } = useJob(processTask)

  return (
    <div>
      <button
        onClick={() => trigger({ taskId: '123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Processing...' : 'Process Task'}
      </button>

      {progress && (
        <progress value={progress.current} max={progress.total} />
      )}

      {status === 'completed' && <div>Done: {output?.success ? 'Yes' : 'No'}</div>}
    </div>
  )
}
```

---

## パターン B: サーバー連携モード

サーバーで Durably を実行し、クライアントは HTTP/SSE で接続する。

### サーバー側（Web 標準 API）

```ts
// app/routes/api.durably.ts (React Router / Remix example)
import { createDurablyHandler } from '@coji/durably/server'
import { durably } from '~/lib/durably.server'

const handler = createDurablyHandler(durably)

// 全ルートを自動処理（推奨）
export async function loader({ request }: LoaderFunctionArgs) {
  return handler.handle(request, '/api/durably')
}

export async function action({ request }: ActionFunctionArgs) {
  return handler.handle(request, '/api/durably')
}
```

または手動で実装:

```ts
// POST /api/durably/trigger
export async function action({ request }: ActionFunctionArgs) {
  const { jobName, input } = await request.json()
  const job = durably.getJob(jobName)
  const run = await job.trigger(input)
  return Response.json({ runId: run.id })
}

// GET /api/durably/subscribe?runId=xxx
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')

  if (!runId) {
    return new Response('Missing runId', { status: 400 })
  }

  const stream = durably.subscribe(runId)

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
```

### クライアント側（軽量）

```tsx
// component.tsx
import { useJob } from '@coji/durably-react/client'

function TaskRunner() {
  const { trigger, status, output, progress, isRunning } = useJob({
    baseUrl: '/api/durably',
    jobName: 'process-task',
  })

  return (
    <div>
      <button
        onClick={() => trigger({ taskId: '123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Processing...' : 'Process Task'}
      </button>

      {progress && (
        <progress value={progress.current} max={progress.total} />
      )}

      {status === 'completed' && <div>Done!</div>}
    </div>
  )
}
```

---

## API 仕様

### ブラウザ完結モード (`@coji/durably-react`)

#### DurablyProvider

```tsx
// Promise を渡す場合（推奨）
<DurablyProvider durably={durablyPromise} fallback={<Loading />}>
  {children}
</DurablyProvider>

// 解決済みインスタンスを渡す場合
<DurablyProvider
  durably={durably}
  autoStart={true}
  onReady={(durably) => console.log('Ready!')}
>
  {children}
</DurablyProvider>
```

| Prop | 型 | 必須 | 説明 |
|------|-----|------|------|
| `durably` | `Durably \| Promise<Durably>` | Yes | Durably インスタンスまたは Promise |
| `autoStart` | `boolean` | - | 自動 start()（デフォルト: true） |
| `onReady` | `(durably: Durably) => void` | - | 準備完了コールバック |
| `fallback` | `ReactNode` | - | Promise 解決中のフォールバック UI |

#### useDurably

```tsx
const { durably, isReady, error } = useDurably()
```

| 戻り値 | 型 | 説明 |
|--------|-----|------|
| `durably` | `Durably \| null` | インスタンス |
| `isReady` | `boolean` | 初期化完了 |
| `error` | `Error \| null` | 初期化エラー |

#### useJob

```tsx
const {
  isReady,
  trigger,
  triggerAndWait,
  status,
  output,
  error,
  logs,
  progress,
  isRunning,
  isPending,
  isCompleted,
  isFailed,
  currentRunId,
  reset,
} = useJob(jobDefinition, options?)
```

| 引数 | 型 | 説明 |
|------|-----|------|
| `jobDefinition` | `JobDefinition` | ジョブ定義 |
| `options.initialRunId` | `string` | 初期購読 Run ID |
| `options.autoResume` | `boolean` | pending/running の Run を自動再開（デフォルト: true） |
| `options.followLatest` | `boolean` | 新しい Run 開始時に自動切替（デフォルト: true） |

**戻り値の詳細**:

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `isReady` | `boolean` | 準備完了 |
| `trigger(input)` | `Promise<{ runId: string }>` | ジョブを実行、Run ID を返す |
| `triggerAndWait(input)` | `Promise<{ runId: string; output: TOutput }>` | 実行して完了を待つ |
| `status` | `RunStatus \| null` | 現在のステータス |
| `output` | `TOutput \| null` | 完了時の出力 |
| `error` | `string \| null` | 失敗時のエラー |
| `logs` | `LogEntry[]` | ログ一覧 |
| `progress` | `Progress \| null` | 進捗情報 |
| `isRunning` | `boolean` | 実行中 |
| `isPending` | `boolean` | 待機中 |
| `isCompleted` | `boolean` | 完了 |
| `isFailed` | `boolean` | 失敗 |
| `currentRunId` | `string \| null` | 現在の Run ID |
| `reset` | `() => void` | 状態リセット |

#### useJobRun

```tsx
const { status, output, error, logs, progress } = useJobRun({ runId })
```

Run ID のみで購読（trigger なし）。`runId` が `null` の場合は購読せず待機する。

| 引数 | 型 | 説明 |
|------|-----|------|
| `runId` | `string \| null` | 購読する Run ID |

#### useJobLogs

```tsx
const { logs, clear } = useJobLogs({ runId, maxLogs? })
```

| 引数 | 型 | 説明 |
|------|-----|------|
| `runId` | `string \| null` | Run ID |
| `maxLogs` | `number` | 最大ログ数（デフォルト: 100） |

#### useRuns

```tsx
const {
  runs,
  isLoading,
  error,
  page,
  hasMore,
  nextPage,
  prevPage,
  goToPage,
  refresh,
  retry,
  cancel,
} = useRuns(options?)
```

| オプション | 型 | 説明 |
|------------|------|------|
| `jobName` | `string` | ジョブ名でフィルタ |
| `status` | `RunStatus` | ステータスでフィルタ |
| `limit` | `number` | 1ページの件数（デフォルト: 20） |
| `realtime` | `boolean` | リアルタイム更新（デフォルト: true） |

| 戻り値 | 型 | 説明 |
|--------|-----|------|
| `runs` | `Run[]` | Run 一覧 |
| `isLoading` | `boolean` | 読み込み中 |
| `error` | `string \| null` | エラー |
| `page` | `number` | 現在ページ |
| `hasMore` | `boolean` | 次ページあり |
| `nextPage` | `() => void` | 次ページへ |
| `prevPage` | `() => void` | 前ページへ |
| `goToPage` | `(page: number) => void` | 指定ページへ |
| `refresh` | `() => Promise<void>` | 再読み込み |
| `retry` | `(runId: string) => Promise<void>` | Run を再実行 |
| `cancel` | `(runId: string) => Promise<void>` | Run をキャンセル |

---

### サーバー連携モード

#### サーバー側 (`@coji/durably/server`)

```ts
import { createDurablyHandler } from '@coji/durably/server'

const handler = createDurablyHandler(durably, {
  onRequest: async () => {
    await durably.migrate()
    durably.start()
  }
})

// 自動ルーティング（推奨）
handler.handle(request: Request, basePath: string): Promise<Response>

// 個別ハンドラー
handler.trigger(request: Request): Promise<Response>      // POST /trigger
handler.subscribe(request: Request): Response             // GET /subscribe?runId=xxx
handler.runs(request: Request): Promise<Response>         // GET /runs
handler.run(request: Request): Promise<Response>          // GET /run?runId=xxx
handler.retry(request: Request): Promise<Response>        // POST /retry?runId=xxx
handler.cancel(request: Request): Promise<Response>       // POST /cancel?runId=xxx
handler.runsSubscribe(request: Request): Response         // GET /runs/subscribe
```

**API 規約**:

| エンドポイント | メソッド | リクエスト | レスポンス |
|---------------|---------|-----------|-----------|
| `{basePath}/trigger` | POST | `{ jobName, input, idempotencyKey?, concurrencyKey? }` | `{ runId }` |
| `{basePath}/subscribe?runId=xxx` | GET | - | SSE stream (single run) |
| `{basePath}/runs` | GET | `?jobName=&status=&limit=&offset=` | `Run[]` |
| `{basePath}/run?runId=xxx` | GET | - | `Run` or 404 |
| `{basePath}/retry?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/cancel?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/runs/subscribe` | GET | `?jobName=` | SSE stream (run updates) |

> **Note**: 認証・認可、CORS、CSRF の扱いは本仕様のスコープ外。アプリケーション側で適切に実装すること。

**SSE イベント形式**:

```text
data: {"type":"run:start","runId":"xxx","jobName":"process-task","payload":{...}}

data: {"type":"run:progress","runId":"xxx","jobName":"process-task","progress":{"current":1,"total":2}}

data: {"type":"run:complete","runId":"xxx","jobName":"process-task","output":{"success":true},"duration":1234}

data: {"type":"run:fail","runId":"xxx","jobName":"process-task","error":"Something went wrong"}

```

#### クライアント側 (`@coji/durably-react/client`)

```tsx
import { useJob, useJobRun, useJobLogs, useRuns, useRunActions } from '@coji/durably-react/client'

// ジョブ実行 + 購読
const {
  trigger,
  triggerAndWait,
  status,
  output,
  error,
  logs,
  progress,
  isReady,
  isRunning,
  isPending,
  isCompleted,
  isFailed,
  currentRunId,
  reset,
} = useJob({
  baseUrl: '/api/durably',
  jobName: 'process-task',
})

// 既存 Run の購読のみ
const { status, output, error, logs, progress } = useJobRun({
  baseUrl: '/api/durably',
  runId: 'xxx',
})

// ログ購読
const { logs, clear } = useJobLogs({
  baseUrl: '/api/durably',
  runId: 'xxx',
})

// Run 一覧
const { runs, isLoading, refresh, retry, cancel } = useRuns({
  baseUrl: '/api/durably',
  jobName: 'process-task',
})

// Run アクション
const { retry, cancel, isLoading, error } = useRunActions({
  baseUrl: '/api/durably',
})
```

**useJob オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `baseUrl` | `string` | Yes | API エンドポイント |
| `jobName` | `string` | Yes | ジョブ名 |
| `initialRunId` | `string` | - | 初期購読 Run ID（再接続用） |

**useJobRun オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `baseUrl` | `string` | Yes | API エンドポイント |
| `runId` | `string \| null` | Yes | Run ID（`null` の場合は購読しない） |

**useJobLogs オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `baseUrl` | `string` | Yes | API エンドポイント |
| `runId` | `string` | Yes | Run ID |
| `maxLogs` | `number` | - | 保持する最大ログ数（デフォルト: 100） |

**useRuns オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `baseUrl` | `string` | Yes | API エンドポイント |
| `jobName` | `string` | - | ジョブ名でフィルタ |
| `status` | `RunStatus` | - | ステータスでフィルタ |
| `limit` | `number` | - | 1ページの件数（デフォルト: 20） |
| `realtime` | `boolean` | - | リアルタイム更新（デフォルト: true） |

**useRunActions オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `baseUrl` | `string` | Yes | API エンドポイント |

| 戻り値 | 型 | 説明 |
|--------|------|------|
| `retry` | `(runId: string) => Promise<void>` | Run を再実行 |
| `cancel` | `(runId: string) => Promise<void>` | Run をキャンセル |
| `isLoading` | `boolean` | アクション実行中 |
| `error` | `string \| null` | エラーメッセージ |

---

### 型安全クライアントファクトリ

```tsx
import { createDurablyClient, createJobHooks } from '@coji/durably-react/client'
import type { processTask, syncUsers } from './jobs'

// 方法1: createDurablyClient
const client = createDurablyClient<{
  'process-task': typeof processTask
  'sync-users': typeof syncUsers
}>({ baseUrl: '/api/durably' })

const { trigger, status } = client.useJob('process-task')
await trigger({ taskId: '123' })  // 型安全

// 方法2: createJobHooks
const { useProcessTask, useSyncUsers } = createJobHooks<{
  'process-task': typeof processTask
  'sync-users': typeof syncUsers
}>({ baseUrl: '/api/durably' })

const { trigger, status } = useProcessTask()
```

---

## 型定義

```ts
// 共通
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface Progress {
  current: number
  total?: number
  message?: string
}

interface LogEntry {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
  timestamp: string
}

// イベント（SSE で送信される）
type DurablyEvent =
  | { type: 'run:start'; runId: string; jobName: string; payload: unknown }
  | { type: 'run:complete'; runId: string; jobName: string; output: unknown; duration: number }
  | { type: 'run:fail'; runId: string; jobName: string; error: string }
  | { type: 'run:progress'; runId: string; jobName: string; progress: Progress }
  | { type: 'step:start'; runId: string; jobName: string; stepName: string; stepIndex: number }
  | { type: 'step:complete'; runId: string; jobName: string; stepName: string; stepIndex: number; output: unknown }
  | { type: 'log:write'; runId: string; jobName: string; level: 'info' | 'warn' | 'error'; message: string; data: unknown }
```

---

## 依存関係

### ブラウザ完結モード

```text
@coji/durably-react
├── @coji/durably  (peer dependency)
├── react          (peer dependency, >= 18.0.0)
└── react-dom      (peer dependency, >= 18.0.0)
```

```bash
npm install @coji/durably-react @coji/durably kysely zod sqlocal react react-dom
```

### サーバー連携モード

**サーバー**:
```bash
npm install @coji/durably kysely zod better-sqlite3
```

**クライアント**（軽量、`@coji/durably` 不要）:
```bash
npm install @coji/durably-react react react-dom
```

---

## 使用例

### 進捗表示付きバッチ処理（ブラウザ完結）

```tsx
// jobs.ts
export const batchProcess = defineJob({
  name: 'batch-process',
  input: z.object({ items: z.array(z.string()) }),
  output: z.object({ processed: z.number() }),
  run: async (step, payload) => {
    const { items } = payload
    for (let i = 0; i < items.length; i++) {
      await step.run(`process-${i}`, () => processItem(items[i]))
      step.progress(i + 1, items.length, `Processing ${items[i]}`)
    }
    return { processed: items.length }
  },
})

// component.tsx
function BatchProcessor() {
  const { trigger, progress, isRunning, output } = useJob(batchProcess)

  return (
    <div>
      <button
        onClick={() => trigger({ items: ['a', 'b', 'c'] })}
        disabled={isRunning}
      >
        Start
      </button>

      {progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <span>{progress.message}</span>
        </div>
      )}

      {output && <div>Processed: {output.processed}</div>}
    </div>
  )
}
```

### AI エージェント（サーバー連携）

```tsx
// サーバー: jobs.server.ts
export const aiAgent = defineJob({
  name: 'ai-agent',
  input: z.object({ prompt: z.string() }),
  output: z.object({ response: z.string() }),
  run: async (step, { prompt }) => {
    step.log.info('Processing prompt', { prompt })

    const plan = await step.run('plan', () => generatePlan(prompt))
    step.progress(1, 3, 'Planning...')

    const research = await step.run('research', () => doResearch(plan))
    step.progress(2, 3, 'Researching...')

    const response = await step.run('generate', () => generate(research))
    step.progress(3, 3, 'Generating...')

    return { response }
  },
})

// クライアント: component.tsx
import { useJob } from '@coji/durably-react/client'

function AIChat() {
  const { trigger, status, progress, output, logs } = useJob({
    baseUrl: '/api/durably',
    jobName: 'ai-agent',
  })

  return (
    <div>
      <button onClick={() => trigger({ prompt: 'Hello' })}>
        Send
      </button>

      {progress && <div>{progress.message}</div>}

      <div>
        {logs.map((log, i) => (
          <div key={i}>[{log.level}] {log.message}</div>
        ))}
      </div>

      {output && <div>{output.response}</div>}
    </div>
  )
}
```

### ページリロード後の再接続

```tsx
import { useJob } from '@coji/durably-react/client'
import { useSearchParams } from 'react-router'

function TaskPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const runId = searchParams.get('runId')

  const { trigger, status, output } = useJob({
    baseUrl: '/api/durably',
    jobName: 'process-task',
    initialRunId: runId ?? undefined,  // 既存 Run を再購読
  })

  const handleStart = async () => {
    const { runId } = await trigger({ taskId: '123' })
    setSearchParams({ runId })  // URL に保存
  }

  return (
    <div>
      <button onClick={handleStart} disabled={status === 'running'}>
        Start
      </button>
      {status === 'completed' && <pre>{JSON.stringify(output)}</pre>}
    </div>
  )
}
```

### Run 一覧ダッシュボード

```tsx
import { useRuns } from '@coji/durably-react'

function Dashboard() {
  const {
    runs,
    isLoading,
    page,
    hasMore,
    nextPage,
    prevPage,
    refresh,
    retry,
    cancel,
  } = useRuns({ limit: 10 })

  return (
    <div>
      <button onClick={refresh}>Refresh</button>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Job</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{run.id}</td>
              <td>{run.jobName}</td>
              <td>{run.status}</td>
              <td>
                {run.status === 'failed' && (
                  <button onClick={() => retry(run.id)}>Retry</button>
                )}
                {run.status === 'pending' && (
                  <button onClick={() => cancel(run.id)}>Cancel</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div>
        <button onClick={prevPage} disabled={page === 0}>Prev</button>
        <span>Page {page + 1}</span>
        <button onClick={nextPage} disabled={!hasMore}>Next</button>
      </div>
    </div>
  )
}
```

---

## 内部実装指針

### ブラウザ完結モード

- `DurablyProvider` で渡された `durably` インスタンスを Context に保持
- `autoStart=true` の場合、マウント時に `durably.start()` を呼び出し
- `useJob` は `durably.on()` でイベント購読
- アンマウント時にリスナー解除

### サーバー連携モード

- `useJob` は `fetch()` で trigger、`EventSource` で購読
- SSE の再接続は自動（EventSource の標準動作）
- `@coji/durably` に依存しない

### Strict Mode 対応

- ref で初期化済みフラグを管理
- 二重マウントでも正しく動作

---

## 将来拡張

### Streaming 対応

`step.stream()` でトークン単位のストリーミングを追加予定。

```tsx
// 将来
const { trigger, chunks, fullText, isStreaming } = useJobStream({
  baseUrl: '/api/durably',
  jobName: 'ai-chat',
})
```

### カスタム API アダプター

```tsx
// 将来: カスタム API 実装
const { trigger, status } = useJob({
  trigger: async (input) => {
    const res = await fetch('/custom/trigger', { ... })
    return res.json()
  },
  subscribe: (runId) => new EventSource(`/custom/subscribe/${runId}`),
})
```
