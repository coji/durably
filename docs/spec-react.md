# @coji/durably-react 仕様書

## Why: なぜ React 統合が必要か

Durably をブラウザの React アプリケーションで使用する場合、以下の課題が発生する。

1. **ライフサイクル管理の複雑さ**: Durably インスタンスの初期化・終了を React のライフサイクルに合わせる必要がある
2. **イベントリスナーの蓄積**: コンポーネントのマウント/アンマウントでリスナーが適切にクリーンアップされない
3. **状態管理のボイラープレート**: Run のステータス、進捗、ログを React の状態として管理するコードが冗長
4. **型安全性の欠如**: イベントハンドラやジョブ出力の型が失われやすい

React 統合パッケージはこれらを解決し、宣言的で型安全な API を提供する。

---

## What: これは何か

`@coji/durably-react` は、Durably を React アプリケーションで使うためのバインディングである。

### 提供するもの

| Export             | 説明                                         |
| ------------------ | -------------------------------------------- |
| `DurablyProvider`  | Durably インスタンスのライフサイクル管理     |
| `useDurably()`     | Durably インスタンスと初期化状態へのアクセス |
| `useJob(job)`      | ジョブの実行とステータス管理                 |
| `useJobRun(runId)` | 特定の Run のステータス購読                  |
| `useJobLogs()`     | リアルタイムログ購読                         |

※ `defineJob` は `@coji/durably` から直接 import する。

---

## 基本的な使い方

```tsx
// ========================================
// 1. ジョブ定義（React の外、静的）
// ========================================
// jobs.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const processTask = defineJob({
  name: 'process-task',
  input: z.object({ taskId: z.string() }),
  output: z.object({ success: z.boolean() }),
  run: async (step, payload) => {
    await step.run('validate', () => validate(payload.taskId))
    await step.run('process', () => process(payload.taskId))
    return { success: true }
  },
})

// ========================================
// 2. Provider（root）
// ========================================
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

// ========================================
// 3. 使用（シンプル）
// ========================================
// component.tsx
import { useJob } from '@coji/durably-react'
import { processTask } from './jobs'

function TaskRunner() {
  const { trigger, status, output, isRunning } = useJob(processTask)

  return (
    <div>
      <button
        onClick={() => trigger({ taskId: '123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Processing...' : 'Process Task'}
      </button>

      {status === 'completed' && <div>Done: {output?.success ? '✓' : '✗'}</div>}
    </div>
  )
}
```

---

## API 仕様

### DurablyProvider

Durably インスタンスを作成し、子コンポーネントに提供する。

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'

function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
      options={{
        pollingInterval: 1000,
        heartbeatInterval: 5000,
        staleThreshold: 30000,
      }}
    >
      <MyApp />
    </DurablyProvider>
  )
}
```

#### Props

| Prop             | 型                 | 必須 | 説明                                                           |
| ---------------- | ------------------ | ---- | -------------------------------------------------------------- |
| `dialectFactory` | `() => Dialect`    | ✓    | Dialect を生成するファクトリ関数（Provider 内部で一度だけ実行）|
| `options`        | `DurablyOptions`   | -    | Durably 設定オプション                                         |
| `autoStart`      | `boolean`          | -    | マウント時に自動で `start()` を呼ぶ（デフォルト: true）        |
| `autoMigrate`    | `boolean`          | -    | マウント時に自動で `migrate()` を呼ぶ（デフォルト: true）      |
| `children`       | `ReactNode`        | ✓    | 子コンポーネント                                               |

#### なぜ `dialectFactory` なのか

コアライブラリの `createDurably({ dialect })` は dialect インスタンスを直接受け取る。これはアプリケーション起動時に一度だけ呼ばれるためである。

一方、React コンポーネントは再レンダリングのたびに関数が実行される。`dialect` を直接渡すと毎回新しいインスタンスが生成されてしまう。`dialectFactory` はファクトリ関数を受け取り、Provider 内部で一度だけ実行することでこの問題を回避する。

#### ライフサイクル

1. **マウント時**: `dialectFactory()` → `createDurably()` → `migrate()` → `start()` の順で初期化
2. **アンマウント時**: `stop()` を呼び、イベントリスナーをすべて解除
3. **Strict Mode**: 二重マウントでも正しく動作（ref で初期化済みフラグを管理）

### useDurably

Durably インスタンスと初期化状態を取得する。通常は `useJob` を使うため、直接使用することは少ない。

```tsx
import { useDurably } from '@coji/durably-react'

function MyComponent() {
  const { durably, isReady, error } = useDurably()

  if (error) return <div>Error: {error.message}</div>
  if (!isReady) return <div>Loading...</div>

  // durably インスタンスを直接使用
}
```

#### 戻り値

| プロパティ | 型               | 説明                                    |
| ---------- | ---------------- | --------------------------------------- |
| `durably`  | `Durably \| null`| Durably インスタンス（未初期化時は null）|
| `isReady`  | `boolean`        | 初期化完了フラグ                        |
| `error`    | `Error \| null`  | 初期化エラー                            |

### useJob

ジョブの実行とステータス管理を行う。`JobDefinition` を受け取り、自動で durably に登録する。

```tsx
import { useJob } from '@coji/durably-react'
import { processTask } from './jobs'

function TaskRunner() {
  const {
    isReady,
    trigger,
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
  } = useJob(processTask)

  return (
    <div>
      <button
        onClick={() => trigger({ taskId: '123' })}
        disabled={!isReady || isRunning}
      >
        {!isReady ? 'Initializing...' : isRunning ? 'Running...' : 'Run Job'}
      </button>

      {progress && (
        <progress value={progress.current} max={progress.total} />
      )}

      {isCompleted && <div>Result: {JSON.stringify(output)}</div>}
      {isFailed && <div>Error: {error}</div>}

      <ul>
        {logs.map((log) => (
          <li key={log.id}>{log.message}</li>
        ))}
      </ul>
    </div>
  )
}
```

#### 引数

| 引数      | 型                                      | 説明                                             |
| --------- | --------------------------------------- | ------------------------------------------------ |
| `job`     | `JobDefinition<TName, TInput, TOutput>` | ジョブ定義                                       |
| `options` | `UseJobOptions`                         | オプション設定（省略可）                         |

#### UseJobOptions

| プロパティ     | 型       | 説明                                                     |
| -------------- | -------- | -------------------------------------------------------- |
| `initialRunId` | `string` | 初期状態で購読する Run ID（ページリロード時の復元に使用）|

#### 戻り値

| プロパティ       | 型                                                              | 説明                                 |
| ---------------- | --------------------------------------------------------------- | ------------------------------------ |
| `isReady`        | `boolean`                                                       | Durably 初期化完了フラグ             |
| `trigger`        | `(input: TInput, options?: TriggerOptions) => Promise<Run>`     | ジョブを実行                         |
| `triggerAndWait` | `(input: TInput, options?: TriggerOptions) => Promise<{...}>`   | 実行して完了を待つ                   |
| `status`         | `RunStatus \| null`                                             | 現在の Run のステータス              |
| `output`         | `TOutput \| null`                                               | 完了時の出力（型安全）               |
| `error`          | `string \| null`                                                | 失敗時のエラーメッセージ             |
| `logs`           | `LogEntry[]`                                                    | リアルタイムログ                     |
| `progress`       | `Progress \| null`                                              | 進捗情報                             |
| `isRunning`      | `boolean`                                                       | 実行中かどうか                       |
| `isPending`      | `boolean`                                                       | 待機中かどうか                       |
| `isCompleted`    | `boolean`                                                       | 完了したかどうか                     |
| `isFailed`       | `boolean`                                                       | 失敗したかどうか                     |
| `currentRunId`   | `string \| null`                                                | 現在の Run ID                        |
| `reset`          | `() => void`                                                    | 状態をリセット                       |

※ `isReady` が `false` の間は `trigger()` を呼ばないこと。呼んだ場合は例外がスローされる。

#### 動作

- `useJob` 呼び出し時に、内部で `durably.register(job)` を実行
- `trigger()` 呼び出し時にイベントリスナーを登録
- Run の完了/失敗時に自動でリスナーを解除
- コンポーネントのアンマウント時にもリスナーを解除

### useJobRun

特定の Run ID のステータスを購読する。ページリロード後に既存の Run を再購読する場合に使用。

> **Note**: ページリロード時の Run 復元には `useJob` の `initialRunId` オプションを使うことを推奨。
> `useJobRun` は、ジョブ定義なしで Run ID のみで購読したい場合に使用する。

```tsx
// 推奨: useJob + initialRunId（trigger も使える）
import { useJob } from '@coji/durably-react'
import { useSearchParams } from 'react-router'
import { processTask } from './jobs'

function TaskRunner() {
  const [searchParams, setSearchParams] = useSearchParams()
  const runId = searchParams.get('runId')

  const { isReady, trigger, status, output } = useJob(processTask, {
    initialRunId: runId ?? undefined,
  })

  const handleRun = async () => {
    const run = await trigger({ taskId: '123' })
    setSearchParams({ runId: run.id })
  }

  return (
    <div>
      <button onClick={handleRun} disabled={!isReady || status === 'running'}>
        Run
      </button>
      {status === 'completed' && <div>Result: {JSON.stringify(output)}</div>}
    </div>
  )
}
```

```tsx
// useJobRun: Run ID のみで購読（trigger なし）
import { useJobRun } from '@coji/durably-react'
import { useSearchParams } from 'react-router'

function RunStatus() {
  const [searchParams] = useSearchParams()
  const runId = searchParams.get('runId')

  const { status, output, error, logs, progress } = useJobRun(runId)

  if (!runId) return <div>No run ID</div>

  return (
    <div>
      <h2>Run: {runId}</h2>
      <p>Status: {status}</p>

      {progress && (
        <progress value={progress.current} max={progress.total} />
      )}

      {status === 'completed' && (
        <pre>{JSON.stringify(output, null, 2)}</pre>
      )}

      {status === 'failed' && (
        <div className="error">{error}</div>
      )}
    </div>
  )
}
```

#### 引数

| 引数    | 型               | 説明            |
| ------- | ---------------- | --------------- |
| `runId` | `string \| null` | 購読する Run ID |

#### 戻り値

`useJob` の戻り値から `trigger` 系を除いたもの。

### useJobLogs

ログをリアルタイムで購読する。

```tsx
import { useJobLogs } from '@coji/durably-react'

function LogViewer({ runId }: { runId?: string }) {
  const { logs, clear } = useJobLogs({ runId, maxLogs: 100 })

  return (
    <div>
      <button onClick={clear}>Clear</button>
      <ul>
        {logs.map((log) => (
          <li key={log.id} className={`log-${log.level}`}>
            [{log.timestamp}] {log.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

#### オプション

| オプション | 型       | 説明                                      |
| ---------- | -------- | ----------------------------------------- |
| `runId`    | `string` | 特定の Run のログのみ購読（省略時は全ログ）|
| `maxLogs`  | `number` | 保持する最大ログ数（デフォルト: 100）     |

#### 戻り値

| プロパティ | 型           | 説明               |
| ---------- | ------------ | ------------------ |
| `logs`     | `LogEntry[]` | ログエントリの配列 |
| `clear`    | `() => void` | ログをクリア       |

---

## 型定義

```ts
interface DurablyOptions {
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
}

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

interface Run<TOutput = unknown> {
  id: string
  jobName: string
  status: RunStatus
  output: TOutput | null
  error: string | null
  progress: Progress | null
  createdAt: string
  updatedAt: string
}
```

---

## 使用例

### 進捗表示付きバッチ処理

```tsx
// jobs.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const batchProcess = defineJob({
  name: 'batch-process',
  input: z.object({ items: z.array(z.string()) }),
  output: z.object({ processed: z.number() }),
  run: async (step, payload) => {
    const { items } = payload
    let processed = 0

    for (let i = 0; i < items.length; i++) {
      await step.run(`process-${items[i]}`, async () => {
        await processItem(items[i])
      })
      processed++
      step.progress(processed, items.length, `Processing ${items[i]}`)
    }

    return { processed }
  },
})

// component.tsx
import { useJob } from '@coji/durably-react'
import { batchProcess } from './jobs'

function BatchProcessor() {
  const { trigger, progress, isRunning, output } = useJob(batchProcess)

  return (
    <div>
      <button
        onClick={() => trigger({ items: ['a', 'b', 'c', 'd', 'e'] })}
        disabled={isRunning}
      >
        Start Batch
      </button>

      {progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <span>{progress.message}</span>
        </div>
      )}

      {output && <div>Processed: {output.processed} items</div>}
    </div>
  )
}
```

### ページリロード後の再接続

```tsx
import { useJob, useJobRun } from '@coji/durably-react'
import { useSearchParams, useNavigate } from 'react-router'
import { processTask } from './jobs'

function TaskPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const existingRunId = searchParams.get('runId')

  // 新規実行用
  const { trigger, currentRunId } = useJob(processTask)

  // 既存 Run の購読用
  const { status, progress, output } = useJobRun(existingRunId ?? currentRunId)

  const handleStart = async () => {
    const run = await trigger({ taskId: 'task-1' })
    navigate(`?runId=${run.id}`)  // URL に runId を保存
  }

  return (
    <div>
      <button onClick={handleStart} disabled={status === 'running'}>
        Start Task
      </button>

      {status && <p>Status: {status}</p>}
      {progress && <progress value={progress.current} max={progress.total} />}
      {output && <pre>{JSON.stringify(output, null, 2)}</pre>}
    </div>
  )
}
```

---

## 内部実装指針

### useJob の実装

```tsx
function useJob<TName extends string, TInput, TOutput>(
  jobDef: JobDefinition<TName, TInput, TOutput>
) {
  const { durably, isReady } = useDurably()
  const [state, setState] = useState(initialState)
  const listenersRef = useRef<Array<() => void>>([])
  const jobHandleRef = useRef<JobHandle<TName, TInput, TOutput> | null>(null)

  // ジョブを登録
  useEffect(() => {
    if (!durably || !isReady) return
    jobHandleRef.current = durably.register(jobDef)
  }, [durably, isReady, jobDef.name])

  const trigger = useCallback(async (input: TInput, options?: TriggerOptions) => {
    const jobHandle = jobHandleRef.current
    if (!durably || !jobHandle) {
      throw new Error('Durably not initialized')
    }

    const run = await jobHandle.trigger(input, options)
    setState(s => ({ ...s, currentRunId: run.id, status: 'pending' }))

    // リスナー登録
    const unsubs = [
      durably.on('run:start', (e) => {
        if (e.runId === run.id) {
          setState(s => ({ ...s, status: 'running' }))
        }
      }),
      durably.on('run:complete', (e) => {
        if (e.runId === run.id) {
          setState(s => ({ ...s, status: 'completed', output: e.output }))
          cleanup()
        }
      }),
      durably.on('run:fail', (e) => {
        if (e.runId === run.id) {
          setState(s => ({ ...s, status: 'failed', error: e.error }))
          cleanup()
        }
      }),
      durably.on('log:write', (e) => {
        if (e.runId === run.id) {
          setState(s => ({ ...s, logs: [...s.logs, e] }))
        }
      }),
    ]

    listenersRef.current = unsubs
    return run
  }, [durably])

  const cleanup = useCallback(() => {
    listenersRef.current.forEach(unsub => unsub())
    listenersRef.current = []
  }, [])

  useEffect(() => cleanup, [cleanup])

  return { trigger, ...state }
}
```

---

## Durably コア側の要件

React 統合を実現するために、コアライブラリに以下が必要。

### 1. イベントリスナーの解除機能

`on()` が unsubscribe 関数を返す必要がある。

```ts
const unsubscribe = durably.on('run:complete', handler)
unsubscribe() // リスナーを解除
```

### 2. register メソッド

`JobDefinition` を受け取り、`JobHandle` を返す。

```ts
const jobHandle = durably.register(jobDef)
```

---

## 依存関係

```
@coji/durably-react
├── @coji/durably  (peer dependency)
├── react          (peer dependency, >= 18.0.0)
└── react-dom      (peer dependency, >= 18.0.0)

@coji/durably
├── kysely         (peer dependency)
└── zod            (peer dependency)
```

インストール（ブラウザ環境）:

```bash
npm install @coji/durably-react @coji/durably kysely zod sqlocal react react-dom
```

---

## 検討事項

### SSR 対応

- `DurablyProvider` はクライアントサイドのみで動作
- SSR 時は `isReady: false` を返し、ハイドレーション後に初期化

### React 19 の Strict Mode

- 開発モードでの二重マウントに対応
- ref を使った初期化済みフラグで重複初期化を防止

### エラーバウンダリ

- Provider 初期化エラーは `error` として公開
- 子コンポーネントでエラーバウンダリを使用することを推奨

---

## 将来拡張への準備

### Streaming 対応 (spec-streaming.md 参照)

v2 で `durably.subscribe()` が実装された際、以下の拡張を予定している。現在の設計はこれらを妨げないよう考慮されている。

#### 1. useJob の events 追加

```tsx
// v1（現在）
const { trigger, status, output, logs, progress } = useJob(job)

// v2（将来）- events を追加
const { trigger, status, output, logs, progress, events } = useJob(job)

// events は AsyncIterable<DurablyEvent>
for await (const event of events) {
  if (event.type === 'stream') {
    // トークン単位のストリーミングデータ
    console.log(event.data)
  }
}
```

`events` は v1 では `null` を返す。v2 で追加しても破壊的変更にならない。

#### 2. 内部実装の切り替え

| バージョン | イベント購読方式                                            |
| ---------- | ----------------------------------------------------------- |
| v1         | `durably.on()` ベース（同期的、プロセス内のみ）             |
| v2         | `durably.subscribe()` ベース（ReadableStream、再接続対応）  |

外部 API は変わらない。内部で使用するイベントソースを切り替える。

#### 3. useJobStream フック（新規、v2）

streaming 専用のフック。`step.stream()` の emit をリアルタイムで消費する。

```tsx
import { useJobStream } from '@coji/durably-react'

function AIChat() {
  const { trigger, isStreaming, chunks, fullText } = useJobStream(chatJob)

  return (
    <div>
      <button onClick={() => trigger({ prompt: 'Hello' })}>
        Send
      </button>

      {isStreaming && (
        <div className="streaming">
          {chunks.map((chunk, i) => (
            <span key={i}>{chunk.text}</span>
          ))}
        </div>
      )}

      {!isStreaming && fullText && (
        <div className="complete">{fullText}</div>
      )}
    </div>
  )
}
```

#### 4. サーバー実行 + クライアント購読

サーバーサイドで Durably を実行し、クライアントで購読するパターン。常駐サーバー（非 Serverless）を前提とする。

```tsx
// サーバー側: Resource Route で SSE エンドポイント
// app/routes/api.runs.$runId.stream.ts
export async function loader({ params }: LoaderFunctionArgs) {
  const stream = await durably.subscribe(params.runId)

  const sseStream = stream.pipeThrough(new TransformStream({
    transform(event, controller) {
      controller.enqueue(`data: ${JSON.stringify(event)}\n\n`)
    }
  }))

  return new Response(sseStream, {
    headers: { 'Content-Type': 'text-event-stream' },
  })
}
```

```tsx
// クライアント側: SSE を消費するフック
import { useEventSource } from '@coji/durably-react/client'

function TaskStatus({ runId }: { runId: string }) {
  const { status, progress, output } = useEventSource(
    `/api/runs/${runId}/stream`
  )

  return <div>Status: {status}</div>
}
```

`@coji/durably-react/client` は Durably 本体に依存しない軽量なフック集として提供予定。

### 設計上の考慮事項

1. **useJob の戻り値は拡張可能**
   - 新しいプロパティを追加しても既存コードは壊れない
   - `events` など将来のプロパティは `null` または `undefined` を返す

2. **Provider の props は安定**
   - `dialect` と `options` の構造は変わらない
   - 新しいオプションは追加されるが、既存は維持

3. **内部でのイベントソース抽象化**
   - `on()` から `subscribe()` への移行を内部で吸収
   - フック利用者は実装の詳細を意識しない
