# @coji/durably-react 仕様書

## 概要

`@coji/durably-react` は、Durably を React アプリケーションで使うためのバインディングである。

Vercel AI SDK v5 のアーキテクチャを参考に、以下の2つの動作モードをサポートする:

| モード | 説明 | サーバー | クライアント |
|--------|------|----------|--------------|
| **ブラウザ完結** | ブラウザ内で Durably を実行 | 不要 | `@coji/durably-react` + `@coji/durably` |
| **サーバー連携** | サーバーで Durably を実行、クライアントで購読 | `@coji/durably` | `@coji/durably-react/client`（軽量） |

---

## パッケージ構成

```text
@coji/durably-react
├── index.ts          # ブラウザ完結モード用（DurablyProvider + hooks）
└── client.ts         # サーバー連携モード用（軽量、@coji/durably 不要）

@coji/durably
└── server.ts         # サーバー側ヘルパー（Web 標準 API）
```

---

## パターン A: ブラウザ完結モード

ブラウザ内で SQLite（OPFS）を使い、Durably を完全にクライアントサイドで実行する。

### セットアップ

```tsx
// root.tsx
import { DurablyProvider } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'

export default function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
    >
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
// app/routes/api.durably.ts (Remix example)
import { createDurablyHandler } from '@coji/durably/server'
import { durably } from '~/lib/durably.server'

const handler = createDurablyHandler(durably)

// POST /api/durably - ジョブ起動
export async function action({ request }: ActionFunctionArgs) {
  return handler.trigger(request)
}

// GET /api/durably?runId=xxx - SSE 購読
export async function loader({ request }: LoaderFunctionArgs) {
  return handler.subscribe(request)
}
```

または手動で実装:

```ts
// POST /api/durably
export async function action({ request }: ActionFunctionArgs) {
  const { jobName, input } = await request.json()
  const job = durably.getJob(jobName)
  const run = await job.trigger(input)
  return Response.json({ runId: run.id })
}

// GET /api/durably?runId=xxx
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
    api: '/api/durably',
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
<DurablyProvider
  dialectFactory={() => dialect}
  options={{ pollingInterval: 1000 }}
  autoStart={true}
  autoMigrate={true}
>
  {children}
</DurablyProvider>
```

| Prop | 型 | 必須 | 説明 |
|------|-----|------|------|
| `dialectFactory` | `() => Dialect` | Yes | Dialect ファクトリ（一度だけ実行） |
| `options` | `DurablyOptions` | - | Durably 設定 |
| `autoStart` | `boolean` | - | 自動 start()（デフォルト: true） |
| `autoMigrate` | `boolean` | - | 自動 migrate()（デフォルト: true） |

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

**戻り値の詳細**:

| メソッド                | 戻り値                                        | 説明                        |
|-------------------------|-----------------------------------------------|-----------------------------|
| `trigger(input)`        | `Promise<{ runId: string }>`                  | ジョブを実行、Run ID を返す |
| `triggerAndWait(input)` | `Promise<{ runId: string; output: TOutput }>` | 実行して完了を待つ          |

#### useJobRun

```tsx
const { status, output, error, logs, progress } = useJobRun({ runId })
```

Run ID のみで購読（trigger なし）。

| 引数    | 型               | 説明            |
|---------|------------------|-----------------|
| `runId` | `string \| null` | 購読する Run ID |

#### useJobLogs

```tsx
const { logs, clear } = useJobLogs({ runId?, maxLogs? })
```

---

### サーバー連携モード

#### サーバー側 (`@coji/durably/server`)

```ts
import { createDurablyHandler } from '@coji/durably/server'

const handler = createDurablyHandler(durably)

// Request handlers
handler.trigger(request: Request): Promise<Response>  // POST
handler.subscribe(request: Request): Response         // GET (SSE)
```

**API 規約**:

| エンドポイント | メソッド | リクエスト | レスポンス |
|---------------|---------|-----------|-----------|
| `/api/durably` | POST | `{ jobName, input }` | `{ runId }` |
| `/api/durably?runId=xxx` | GET | - | SSE stream |

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
import { useJob, useJobRun } from '@coji/durably-react/client'

// ジョブ実行 + 購読
const { trigger, status, progress, output } = useJob({
  api: '/api/durably',
  jobName: 'process-task',
})

// 既存 Run の購読のみ
const { status, progress, output } = useJobRun({
  api: '/api/durably',
  runId: 'xxx',
})
```

| オプション     | 型       | 必須            | 説明                           |
|----------------|----------|-----------------|--------------------------------|
| `api`          | `string` | Yes             | API エンドポイント             |
| `jobName`      | `string` | Yes (useJob)    | ジョブ名                       |
| `runId`        | `string` | Yes (useJobRun) | Run ID                         |
| `initialRunId` | `string` | -               | 初期購読 Run ID（再接続用）    |

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
  | { type: 'step:start'; runId: string; stepName: string; stepIndex: number }
  | { type: 'step:complete'; runId: string; stepName: string; stepIndex: number; output: unknown }
  | { type: 'log:write'; runId: string; level: 'info' | 'warn' | 'error'; message: string; data: unknown }
```

---

## 依存関係

### ブラウザ完結モード

```
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

---

## 内部実装指針

### ブラウザ完結モード

- `DurablyProvider` で `createDurably()` → `migrate()` → `start()`
- `useJob` は `durably.on()` でイベント購読
- アンマウント時に `stop()` とリスナー解除

### サーバー連携モード

- `useJob` は `fetch()` で trigger、`EventSource` で購読
- SSE の再接続は自動（EventSource の標準動作）
- `@coji/durably` に依存しない

### Strict Mode 対応

- ref で初期化済みフラグを管理
- 二重マウントでも正しく動作

---

## Durably コア側の要件

### 既存（実装済み）

- `durably.on()` が unsubscribe 関数を返す
- `durably.register(jobDef)` で JobHandle を取得

### 新規（サーバー連携用）

1. **`durably.subscribe(runId): ReadableStream<DurablyEvent>`**
   - Run のイベントを ReadableStream で返す
   - SSE に変換可能

2. **`durably.getJob(jobName): JobHandle`**
   - 登録済みジョブを名前で取得

3. **`createDurablyHandler(durably)`** (`@coji/durably/server`)
   - Web 標準の Request/Response を扱うヘルパー

---

## 将来拡張

### キャンセル API

Run のキャンセル機能を追加予定。

```tsx
// useJob に cancel を追加
const { trigger, cancel, status } = useJob(job)
await cancel()  // 現在の Run をキャンセル

// サーバー API
DELETE /api/durably?runId=xxx  → { success: true }
```

> **Note**: キャンセルは cooperative。ステップ実行中は即座に止められず、次のステップに進む前にチェックされる。

### Streaming 対応

`step.stream()` でトークン単位のストリーミングを追加予定。

```tsx
// 将来
const { trigger, chunks, fullText, isStreaming } = useJobStream({
  api: '/api/durably',
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
