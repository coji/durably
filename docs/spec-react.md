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
  isCancelled,
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
| `isCancelled` | `boolean` | キャンセル |
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
  isReady,
  runs,
  isLoading,
  page,
  hasMore,
  nextPage,
  prevPage,
  goToPage,
  refresh,
} = useRuns(options?)
```

| オプション | 型 | 説明 |
|------------|------|------|
| `jobName` | `string` | ジョブ名でフィルタ |
| `status` | `RunStatus` | ステータスでフィルタ |
| `pageSize` | `number` | 1ページの件数（デフォルト: 10） |
| `realtime` | `boolean` | リアルタイム更新（デフォルト: true） |

| 戻り値 | 型 | 説明 |
|--------|-----|------|
| `isReady` | `boolean` | 準備完了 |
| `runs` | `Run[]` | Run 一覧 |
| `isLoading` | `boolean` | 読み込み中 |
| `page` | `number` | 現在ページ |
| `hasMore` | `boolean` | 次ページあり |
| `nextPage` | `() => void` | 次ページへ |
| `prevPage` | `() => void` | 前ページへ |
| `goToPage` | `(page: number) => void` | 指定ページへ |
| `refresh` | `() => Promise<void>` | 再読み込み |

> **Note**: Run アクション（retry, cancel, delete）は `useDurably` から取得した Durably インスタンスを使用するか、サーバー連携モードでは `useRunActions` を使用する。

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
handler.steps(request: Request): Promise<Response>        // GET /steps?runId=xxx
handler.retry(request: Request): Promise<Response>        // POST /retry?runId=xxx
handler.cancel(request: Request): Promise<Response>       // POST /cancel?runId=xxx
handler.delete(request: Request): Promise<Response>       // DELETE /run?runId=xxx
handler.runsSubscribe(request: Request): Response         // GET /runs/subscribe
```

**API 規約**:

| エンドポイント | メソッド | リクエスト | レスポンス |
|---------------|---------|-----------|-----------|
| `{basePath}/trigger` | POST | `{ jobName, input, idempotencyKey?, concurrencyKey? }` | `{ runId }` |
| `{basePath}/subscribe?runId=xxx` | GET | - | SSE stream (single run) |
| `{basePath}/runs` | GET | `?jobName=&status=&limit=&offset=` | `Run[]` |
| `{basePath}/run?runId=xxx` | GET | - | `Run` or 404 |
| `{basePath}/steps?runId=xxx` | GET | - | `Step[]` |
| `{basePath}/retry?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/cancel?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/run?runId=xxx` | DELETE | - | `{ success: true }` |
| `{basePath}/runs/subscribe` | GET | `?jobName=` | SSE stream (run updates) |

> **Note**: 認証・認可、CORS、CSRF の扱いは本仕様のスコープ外。アプリケーション側で適切に実装すること。

**SSE イベント形式**:

Single run subscription (`/subscribe?runId=xxx`):
```text
data: {"type":"run:start","runId":"xxx","jobName":"process-task","payload":{...}}

data: {"type":"run:progress","runId":"xxx","jobName":"process-task","progress":{"current":1,"total":2}}

data: {"type":"run:complete","runId":"xxx","jobName":"process-task","output":{"success":true},"duration":1234}

data: {"type":"run:fail","runId":"xxx","jobName":"process-task","error":"Something went wrong"}

data: {"type":"run:cancel","runId":"xxx","jobName":"process-task"}

data: {"type":"run:retry","runId":"xxx","jobName":"process-task"}

```

Runs subscription (`/runs/subscribe`):
```text
data: {"type":"run:trigger","runId":"xxx","jobName":"process-task"}

data: {"type":"run:start","runId":"xxx","jobName":"process-task"}

data: {"type":"run:complete","runId":"xxx","jobName":"process-task"}

data: {"type":"run:fail","runId":"xxx","jobName":"process-task"}

data: {"type":"run:cancel","runId":"xxx","jobName":"process-task"}

data: {"type":"run:retry","runId":"xxx","jobName":"process-task"}

data: {"type":"run:progress","runId":"xxx","jobName":"process-task","progress":{"current":1,"total":2}}

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
  isCancelled,
  currentRunId,
  reset,
} = useJob({
  api: '/api/durably',
  jobName: 'process-task',
})

// 既存 Run の購読のみ
const { status, output, error, logs, progress } = useJobRun({
  api: '/api/durably',
  runId: 'xxx',
})

// ログ購読
const { logs, clear } = useJobLogs({
  api: '/api/durably',
  runId: 'xxx',
})

// Run 一覧
const { runs, isLoading, hasMore, nextPage, prevPage, refresh } = useRuns({
  api: '/api/durably',
  jobName: 'process-task',
})

// Run アクション
const { retry, cancel, deleteRun, getRun, getSteps, isLoading, error } = useRunActions({
  api: '/api/durably',
})
```

#### HITL（Human-in-the-Loop）

HITL は **単一フック** で完結させる。低レベルの `useWaitingRuns` / `useResume` は持たない。

```tsx
import { useHumanWaits } from '@coji/durably-react/client'

const {
  waits,
  isLoading,
  reload,
  respond,
} = useHumanWaits({
  api: '/api/durably',
})

await respond(runId, { decision: 'approved', note: 'OK' })
```

**戻り値**:

| プロパティ | 型 | 説明 |
|-----------|-----|------|
| `waits` | `WaitingRun[]` | `waiting_human` の一覧 |
| `isLoading` | `boolean` | 読み込み中 |
| `reload()` | `() => Promise<void>` | 再取得 |
| `respond(id, payload)` | `Promise<void>` | 任意の payload で再開 |

**`WaitingRun` の最小形**

| フィールド | 型 | 説明 |
|------------|-----|------|
| `id` | `string` | Run ID |
| `wait_message` | `string` | 人に見せる文 |
| `wait_schema` | `string \| null` | 入力スキーマ（任意） |
| `wait_deadline_at` | `string \| null` | 期限 |

**`useHumanWaits` の型定義（提案）**

```ts
type HumanDecision = 'approved' | 'rejected' | 'edited'

type HumanPayload = {
  decision: HumanDecision
  note?: string
  // 任意拡張
  [key: string]: unknown
}

type UseHumanWaitsResult = {
  waits: WaitingRun[]
  isLoading: boolean
  reload: () => Promise<void>
  respond: (runId: string, payload: HumanPayload) => Promise<void>
}
```

**内部動作**
- `GET /api/durably/runs?status=waiting_human` を使用
- `POST /api/durably/resume` を使用（`runId` で再開）

---

#### HITL（ブラウザ完結モード）

ブラウザ完結でも同じ `useHumanWaits()` を使える。API ではなくローカル Durably を直接叩く。

```tsx
import { useHumanWaits } from '@coji/durably-react'

const {
  waits,
  isLoading,
  reload,
  respond,
} = useHumanWaits()
```

**内部動作**
- `durably.getRuns({ status: 'waiting_human' })` を使用
- `durably.resume(runId, payload)` を使用

**useJob オプション**:

| オプション | 型 | 必須 | デフォルト | 説明 |
|------------|------|------|------------|------|
| `api` | `string` | Yes | - | API エンドポイント |
| `jobName` | `string` | Yes | - | ジョブ名 |
| `initialRunId` | `string` | - | - | 初期購読 Run ID（再接続用） |
| `autoResume` | `boolean` | - | `true` | pending/running の Run を自動再開 |
| `followLatest` | `boolean` | - | `true` | 新しい Run 開始時に自動切替 |

**useJobRun オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `api` | `string` | Yes | API エンドポイント |
| `runId` | `string \| null` | Yes | Run ID（`null` の場合は購読しない） |

**useJobLogs オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `api` | `string` | Yes | API エンドポイント |
| `runId` | `string \| null` | Yes | Run ID（`null` の場合は購読しない） |
| `maxLogs` | `number` | - | 保持する最大ログ数（デフォルト: 100） |

**useRuns オプション**:

| オプション | 型 | 必須 | 説明 |
|------------|------|------|------|
| `api` | `string` | Yes | API エンドポイント |
| `jobName` | `string` | - | ジョブ名でフィルタ |
| `status` | `RunStatus` | - | ステータスでフィルタ |
| `pageSize` | `number` | - | 1ページの件数（デフォルト: 10） |

**useRunActions オプション**:

| オプション | 型       | 必須 | 説明               |
|------------|----------|------|--------------------|
| `api`      | `string` | Yes  | API エンドポイント |

| 戻り値      | 型                                                 | 説明            |
|-------------|---------------------------------------------------|-----------------|
| `retry`     | `(runId: string) => Promise<void>`                | Run を再実行    |
| `cancel`    | `(runId: string) => Promise<void>`                | Run をキャンセル |
| `deleteRun` | `(runId: string) => Promise<void>`                | Run を削除      |
| `getRun`    | `(runId: string) => Promise<RunRecord \| null>`   | Run を取得      |
| `getSteps`  | `(runId: string) => Promise<StepRecord[]>`        | Steps を取得    |
| `isLoading` | `boolean`                                         | アクション実行中 |
| `error`     | `string \| null`                                  | エラーメッセージ |

**RunRecord 型**:

```ts
interface RunRecord {
  id: string
  jobName: string
  status: 'pending' | 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled'
  payload: unknown
  output: unknown | null
  error: string | null
  progress: { current: number; total?: number; message?: string } | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}
```

**StepRecord 型**:

```ts
interface StepRecord {
  name: string
  status: 'completed' | 'failed'
  output: unknown
}
```

---

### 型安全クライアントファクトリ

```tsx
import { createDurablyClient, createJobHooks } from '@coji/durably-react/client'
import type { jobs } from './durably.server'  // サーバー側の jobs をインポート

// 方法1: createDurablyClient（推奨）
// サーバー側で register() した jobs の型を使用
const durably = createDurablyClient<typeof jobs>({
  api: '/api/durably',
})

// 型安全なアクセス
const { trigger, status } = durably.processTask.useJob()
await trigger({ taskId: '123' })  // 型安全

const { status, output } = durably.processTask.useRun(runId)
const { logs, clearLogs } = durably.processTask.useLogs(runId)

// 方法2: createJobHooks（単一ジョブ用）
import type { processTaskJob } from './jobs'

const processTaskHooks = createJobHooks<typeof processTaskJob>({
  api: '/api/durably',
  jobName: 'process-task',
})

const { trigger, status } = processTaskHooks.useJob()
```

---

## 型定義

```ts
// 共通
type RunStatus = 'pending' | 'running' | 'waiting_human' | 'completed' | 'failed' | 'cancelled'

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
  | { type: 'run:trigger'; runId: string; jobName: string; payload: unknown }
  | { type: 'run:start'; runId: string; jobName: string; payload: unknown }
  | { type: 'run:complete'; runId: string; jobName: string; output: unknown; duration: number }
  | { type: 'run:fail'; runId: string; jobName: string; error: string; failedStepName: string }
  | { type: 'run:cancel'; runId: string; jobName: string }
  | { type: 'run:retry'; runId: string; jobName: string }
  | { type: 'run:progress'; runId: string; jobName: string; progress: Progress }
  | { type: 'step:start'; runId: string; jobName: string; stepName: string; stepIndex: number }
  | { type: 'step:complete'; runId: string; jobName: string; stepName: string; stepIndex: number; output: unknown; duration: number }
  | { type: 'step:fail'; runId: string; jobName: string; stepName: string; stepIndex: number; error: string }
  | { type: 'log:write'; runId: string; stepName: string | null; level: 'info' | 'warn' | 'error'; message: string; data: unknown }
  | { type: 'worker:error'; error: string; context: string; runId?: string }
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
    api: '/api/durably',
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
    api: '/api/durably',
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

### Run 一覧ダッシュボード（ブラウザ完結モード）

```tsx
import { useRuns, useDurably } from '@coji/durably-react'

function Dashboard() {
  const { durably } = useDurably()
  const {
    runs,
    isLoading,
    page,
    hasMore,
    nextPage,
    prevPage,
    refresh,
  } = useRuns({ pageSize: 10 })

  const handleRetry = async (runId: string) => {
    await durably?.retry(runId)
    refresh()
  }

  const handleCancel = async (runId: string) => {
    await durably?.cancel(runId)
    refresh()
  }

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
                {(run.status === 'failed' || run.status === 'cancelled') && (
                  <button onClick={() => handleRetry(run.id)}>Retry</button>
                )}
                {(run.status === 'pending' || run.status === 'running') && (
                  <button onClick={() => handleCancel(run.id)}>Cancel</button>
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

### Run 一覧ダッシュボード（サーバー連携モード）

```tsx
import { useRuns, useRunActions } from '@coji/durably-react/client'

function Dashboard() {
  const { runs, isLoading, page, hasMore, nextPage, prevPage, refresh } = useRuns({
    api: '/api/durably',
    pageSize: 10,
  })
  const { retry, cancel, isLoading: isActioning } = useRunActions({
    api: '/api/durably',
  })

  const handleRetry = async (runId: string) => {
    await retry(runId)
    refresh()
  }

  const handleCancel = async (runId: string) => {
    await cancel(runId)
    refresh()
  }

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
                {(run.status === 'failed' || run.status === 'cancelled') && (
                  <button onClick={() => handleRetry(run.id)} disabled={isActioning}>
                    Retry
                  </button>
                )}
                {(run.status === 'pending' || run.status === 'running') && (
                  <button onClick={() => handleCancel(run.id)} disabled={isActioning}>
                    Cancel
                  </button>
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

---

## v1 からの変更点

### @coji/durably コアパッケージ

#### 型安全な `durably.jobs` API

`register()` がオブジェクト形式を受け取り、型安全な `jobs` プロパティを返すようになった:

```ts
// 旧: 個別に register
const processImageHandle = durably.register(processImageJob)
const syncUsersHandle = durably.register(syncUsersJob)

// 新: オブジェクト形式で一括登録、型安全な jobs プロパティ
const durably = createDurably({ dialect })
  .register({
    processImage: processImageJob,
    syncUsers: syncUsersJob,
  })

// 型安全なアクセス
await durably.jobs.processImage.trigger({ imageId: '123' })
await durably.jobs.syncUsers.trigger({ source: 'api' })
```

#### 新しいイベント

以下のイベントが追加された:

| イベント        | 説明                                |
|-----------------|-------------------------------------|
| `run:trigger`   | ジョブがトリガーされた時（Worker 実行前） |
| `run:cancel`    | Run がキャンセルされた時             |
| `run:retry`     | Run がリトライされた時               |

#### `subscribe()` メソッド

`durably.subscribe(runId)` で特定 Run のイベントを `ReadableStream` で購読可能:

```ts
const stream = durably.subscribe(runId)
const reader = stream.getReader()

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  console.log(value) // DurablyEvent
}
```

#### `getJob()` メソッド

名前で登録済みジョブを取得:

```ts
const job = durably.getJob('process-image')
if (job) {
  await job.trigger({ imageId: '123' })
}
```

### @coji/durably/server

#### 新しいエンドポイント

| エンドポイント                 | メソッド | 説明                     |
|--------------------------------|----------|--------------------------|
| `{basePath}/steps?runId=xxx`   | GET      | Run のステップ一覧を取得 |
| `{basePath}/run?runId=xxx`     | DELETE   | Run を削除               |

#### SSE イベント拡張

`/runs/subscribe` エンドポイントで以下の新しいイベントを配信:

- `run:trigger` - ジョブトリガー時
- `run:cancel` - キャンセル時
- `run:retry` - リトライ時

### @coji/durably-react/client

#### `useRunActions` の拡張

新しいメソッドが追加された:

| メソッド      | 説明              |
|---------------|-------------------|
| `deleteRun()` | Run を削除        |
| `getRun()`    | Run を取得        |
| `getSteps()`  | Steps を取得      |

新しい型がエクスポートされた:

- `RunRecord` - Run のレコード型
- `StepRecord` - Step のレコード型
