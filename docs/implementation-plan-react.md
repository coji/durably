# @coji/durably-react 実装計画

## 概要

この文書は `@coji/durably-react` パッケージの実装計画を定義する。仕様は `docs/spec-react.md` に基づく。

2つの動作モードをサポート:
- **ブラウザ完結モード**: ブラウザ内で Durably を実行
- **サーバー連携モード**: サーバーで Durably を実行、クライアントは SSE で購読

---

## 1. パッケージ構成

### ディレクトリ構造

```
packages/durably-react/
├── src/
│   ├── index.ts              # ブラウザ完結モード (DurablyProvider + hooks)
│   ├── client.ts             # サーバー連携モード (軽量、@coji/durably 不要)
│   ├── context.tsx           # DurablyContext & DurablyProvider
│   ├── hooks/
│   │   ├── use-durably.ts    # useDurably hook
│   │   ├── use-job.ts        # useJob hook (ブラウザ)
│   │   ├── use-job-run.ts    # useJobRun hook (ブラウザ)
│   │   └── use-job-logs.ts   # useJobLogs hook (ブラウザ)
│   ├── client/
│   │   ├── use-job.ts        # useJob hook (サーバー連携)
│   │   ├── use-job-run.ts    # useJobRun hook (サーバー連携)
│   │   └── use-job-logs.ts   # useJobLogs hook (サーバー連携)
│   └── types.ts              # 共有型定義
├── tests/
│   ├── browser/              # ブラウザ完結モードのテスト
│   └── client/               # サーバー連携モードのテスト
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts
```

### package.json

```json
{
  "name": "@coji/durably-react",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./client": {
      "types": "./dist/client.d.ts",
      "import": "./dist/client.js"
    }
  },
  "peerDependencies": {
    "react": ">=18.0.0",
    "react-dom": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "@coji/durably": {
      "optional": true
    }
  },
  "devDependencies": {
    "@coji/durably": "workspace:*",
    "@testing-library/react": "^16.x",
    "react": "^19.x",
    "react-dom": "^19.x",
    "vitest": "^4.x"
  }
}
```

**ポイント**:
- `@coji/durably` は optional peer dependency（サーバー連携モードでは不要）
- 2つのエントリポイント: `.` と `./client`

---

## 2. コア側の要件

### 既存（実装済み）

- `durably.on()` が unsubscribe 関数を返す ✅
- `durably.register(jobDef)` で JobHandle を取得 ✅
- `run:progress` イベント ✅ (Phase 0 で実装済み)

### 新規（サーバー連携用）

1. **`durably.subscribe(runId): ReadableStream<DurablyEvent>`**
   - Run のイベントを ReadableStream で返す
   - SSE に変換可能

2. **`durably.getJob(jobName): JobHandle`**
   - 登録済みジョブを名前で取得

3. **`createDurablyHandler(durably)`** (`@coji/durably/server`)
   - Web 標準の Request/Response を扱うヘルパー

---

## 3. 実装フェーズ

### Phase 1: 基盤構築

**目標**: パッケージ構造とビルド環境の整備

**タスク**:
1. `packages/durably-react/` ディレクトリ作成
2. `package.json` 作成（2つのエントリポイント）
3. `tsconfig.json` 作成
4. `tsup.config.ts` 作成（`index.ts` と `client.ts` を両方ビルド）
5. `vitest.config.ts` 作成
6. 空のエクスポートでビルド確認

**成果物**:
- 空の durably-react パッケージがビルドできる状態

---

### Phase 2: 共通型定義

**目標**: 両モードで共有する型を定義

**タスク**:
`src/types.ts`:
```ts
// 共通
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Progress {
  current: number
  total?: number
  message?: string
}

export interface LogEntry {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
  timestamp: string
}

// useJob 戻り値（共通部分）
export interface UseJobState<TOutput> {
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
  currentRunId: string | null
}
```

---

### Phase 3: ブラウザ完結モード - Provider

**目標**: DurablyProvider と useDurably の実装

**タスク**:

1. `src/context.tsx`:
```tsx
interface DurablyContextValue {
  durably: Durably | null
  isReady: boolean
  error: Error | null
}

interface DurablyProviderProps {
  dialectFactory: () => Dialect
  options?: DurablyOptions
  autoStart?: boolean      // default: true
  autoMigrate?: boolean    // default: true
  children: ReactNode
}
```

**実装ポイント**:
- `useRef` で初期化済みフラグを管理（StrictMode 対応）
- `dialectFactory()` は一度だけ実行
- マウント時: `createDurably()` → `migrate()` → `start()`
- アンマウント時: `stop()`

2. `src/hooks/use-durably.ts`:
- Context から値を取得
- Provider 外で使用時はエラー

**テスト**:
- 正常な初期化フロー
- StrictMode での二重マウント
- autoStart/autoMigrate オプション

---

### Phase 4: ブラウザ完結モード - useJob

**目標**: ジョブ実行と状態管理

**タスク**:

`src/hooks/use-job.ts`:
```tsx
function useJob<TInput, TOutput>(
  job: JobDefinition<string, TInput, TOutput>,
  options?: { initialRunId?: string }
): {
  isReady: boolean
  trigger: (input: TInput) => Promise<{ runId: string }>
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
  isRunning: boolean
  isPending: boolean
  isCompleted: boolean
  isFailed: boolean
  currentRunId: string | null
  reset: () => void
}
```

**実装ポイント**:
- `useDurably()` で context を取得
- `durably.register(job)` で JobHandle 取得
- `trigger()` 時に `durably.on()` でイベント購読
- Run 完了時にリスナー解除
- `initialRunId` で既存 Run を購読

**テスト**:
- trigger でジョブ実行
- 状態遷移 (pending → running → completed/failed)
- ログ・進捗の収集
- アンマウント時のクリーンアップ

---

### Phase 5: ブラウザ完結モード - useJobRun & useJobLogs

**目標**: 単独の Run 購読とログ購読

**タスク**:

1. `src/hooks/use-job-run.ts`:
```tsx
function useJobRun(options: { runId: string | null }): {
  status: RunStatus | null
  output: unknown
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
}
```

2. `src/hooks/use-job-logs.ts`:
```tsx
function useJobLogs(options: { runId: string; maxLogs?: number }): {
  logs: LogEntry[]
  clear: () => void
}
```

**テスト**:
- 既存 Run の購読
- null runId の扱い
- maxLogs 制限

---

### Phase 6: コア拡張 - サーバー連携用 API

**目標**: `@coji/durably` にサーバー連携用 API を追加

**タスク**:

1. `packages/durably/src/durably.ts` に追加:
```ts
// 登録済みジョブを名前で取得
getJob(jobName: string): JobHandle | undefined

// Run のイベントを ReadableStream で返す
subscribe(runId: string): ReadableStream<DurablyEvent>
```

2. `packages/durably/src/server.ts` 新規作成:
```ts
export function createDurablyHandler(durably: Durably) {
  return {
    // POST: ジョブ起動
    async trigger(request: Request): Promise<Response> {
      const { jobName, input } = await request.json()
      const job = durably.getJob(jobName)
      if (!job) return new Response('Job not found', { status: 404 })
      const run = await job.trigger(input)
      return Response.json({ runId: run.id })
    },

    // GET: SSE 購読
    subscribe(request: Request): Response {
      const url = new URL(request.url)
      const runId = url.searchParams.get('runId')
      if (!runId) return new Response('Missing runId', { status: 400 })

      const stream = durably.subscribe(runId)
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    },
  }
}
```

3. `packages/durably/package.json` の exports に追加:
```json
"./server": {
  "types": "./dist/server.d.ts",
  "import": "./dist/server.js"
}
```

**テスト**:
- `getJob()` で登録済みジョブを取得
- `subscribe()` が ReadableStream を返す
- `createDurablyHandler` の trigger/subscribe

---

### Phase 7: サーバー連携モード - useJob

**目標**: サーバー連携用の軽量 useJob

**タスク**:

`src/client/use-job.ts`:
```tsx
function useJob<TInput, TOutput>(options: {
  api: string
  jobName: string
  initialRunId?: string
}): {
  isReady: true  // 常に true
  trigger: (input: TInput) => Promise<{ runId: string }>
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
  isRunning: boolean
  isPending: boolean
  isCompleted: boolean
  isFailed: boolean
  currentRunId: string | null
  reset: () => void
}
```

**実装ポイント**:
- `fetch()` で trigger
- `EventSource` で SSE 購読
- `@coji/durably` に依存しない
- `isReady` は常に `true`

**テスト**:
- fetch mock で trigger テスト
- EventSource mock で購読テスト

---

### Phase 8: サーバー連携モード - useJobRun & useJobLogs

**目標**: サーバー連携用の useJobRun と useJobLogs

**タスク**:

1. `src/client/use-job-run.ts`:
```tsx
function useJobRun(options: {
  api: string
  runId: string
}): {
  status: RunStatus | null
  output: unknown
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
}
```

2. `src/client/use-job-logs.ts`:
```tsx
function useJobLogs(options: {
  api: string
  runId: string
  maxLogs?: number
}): {
  logs: LogEntry[]
  clear: () => void
}
```

**実装ポイント**:
- `EventSource` で SSE 購読
- API エンドポイントからイベントを受信

---

### Phase 9: エントリポイント整備

**目標**: 公開 API の整備

**タスク**:

1. `src/index.ts` (ブラウザ完結モード):
```ts
// Provider
export { DurablyProvider } from './context'
export type { DurablyProviderProps } from './types'

// Hooks
export { useDurably } from './hooks/use-durably'
export { useJob } from './hooks/use-job'
export { useJobRun } from './hooks/use-job-run'
export { useJobLogs } from './hooks/use-job-logs'

// Types
export type { Progress, LogEntry, RunStatus } from './types'
```

2. `src/client.ts` (サーバー連携モード):
```ts
// Hooks only (no Provider needed)
export { useJob } from './client/use-job'
export { useJobRun } from './client/use-job-run'
export { useJobLogs } from './client/use-job-logs'

// Types
export type { Progress, LogEntry, RunStatus } from './types'
```

---

### Phase 10: ドキュメントと例

**目標**: README とサンプルの整備

**タスク**:
1. `packages/durably-react/README.md` 作成
2. `packages/durably-react/docs/llms.md` 作成
3. `examples/react-browser/` - ブラウザ完結モードの例
4. `examples/react-server/` - サーバー連携モードの例

---

### Phase 11: テストと品質保証

**目標**: 完全なテストカバレッジ

**タスク**:
1. ブラウザモードのテスト (jsdom)
2. サーバー連携モードのテスト (fetch/EventSource mock)
3. StrictMode テスト
4. TypeScript 型チェック
5. Biome lint

---

### Phase 12: パブリッシュ準備

**目標**: npm パブリッシュの準備

**タスク**:
1. version を 0.1.0 に設定
2. CHANGELOG.md 作成
3. `pnpm publish --dry-run` で確認

---

## 4. 実装順序のまとめ

| Phase | 内容 | 依存 |
|-------|------|------|
| 1 | 基盤構築 | - |
| 2 | 共通型定義 | Phase 1 |
| 3 | ブラウザ: Provider | Phase 2 |
| 4 | ブラウザ: useJob | Phase 3 |
| 5 | ブラウザ: useJobRun, useJobLogs | Phase 3 |
| 6 | コア拡張: サーバー連携用 API | - |
| 7 | サーバー連携: useJob | Phase 2, 6 |
| 8 | サーバー連携: useJobRun, useJobLogs | Phase 7 |
| 9 | エントリポイント整備 | Phase 5, 8 |
| 10 | ドキュメント | Phase 9 |
| 11 | テスト・品質保証 | Phase 10 |
| 12 | パブリッシュ準備 | Phase 11 |

---

## 5. 技術的な決定事項

### StrictMode 対応

```tsx
function DurablyProvider({ dialectFactory, children }: Props) {
  const [state, setState] = useState({ durably: null, isReady: false, error: null })
  const initializedRef = useRef(false)

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const dialect = dialectFactory()
    const durably = createDurably({ dialect })
    let cancelled = false

    async function init() {
      try {
        await durably.migrate()
        if (cancelled) return
        durably.start()
        setState({ durably, isReady: true, error: null })
      } catch (error) {
        if (!cancelled) setState(s => ({ ...s, error: error as Error }))
      }
    }

    init()

    return () => {
      cancelled = true
      durably.stop()
    }
  }, [dialectFactory])

  return <Context.Provider value={state}>{children}</Context.Provider>
}
```

### SSE 購読の実装

```tsx
// サーバー連携モードの useJob 内部
function subscribeToRun(runId: string) {
  const eventSource = new EventSource(`${api}?runId=${runId}`)

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data) as DurablyEvent

    switch (data.type) {
      case 'run:start':
        setState(s => ({ ...s, status: 'running' }))
        break
      case 'run:complete':
        setState(s => ({ ...s, status: 'completed', output: data.output }))
        eventSource.close()
        break
      case 'run:fail':
        setState(s => ({ ...s, status: 'failed', error: data.error }))
        eventSource.close()
        break
      case 'run:progress':
        setState(s => ({ ...s, progress: data.progress }))
        break
      case 'log:write':
        setState(s => ({ ...s, logs: [...s.logs, data] }))
        break
    }
  }

  return () => eventSource.close()
}
```

---

## 6. リスクと対策

| リスク | 対策 |
|--------|------|
| StrictMode での予期せぬ動作 | 二重マウントテストを十分に行う |
| EventSource の再接続ループ | エラー時の適切なハンドリング |
| SSE が終了しない | Run 完了時に必ず close() |
| 型推論が複雑で失敗 | ジェネリクスの型テストを追加 |

---

## 7. 完了条件

- [ ] ブラウザ完結モードの全フックが実装されている
- [ ] サーバー連携モードの全フックが実装されている
- [ ] コア側に `getJob`, `subscribe`, `createDurablyHandler` が追加されている
- [ ] 2つのエントリポイント (`.` と `./client`) が機能する
- [ ] StrictMode で正しく動作する
- [ ] 型推論が正しく機能する
- [ ] テストがすべてパスする
- [ ] ドキュメントが整備されている
