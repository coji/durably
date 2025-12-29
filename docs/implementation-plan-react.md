# @coji/durably-react 実装計画

## 概要

この文書は `@coji/durably-react` パッケージの実装計画を定義する。仕様は `docs/spec-react.md` に基づく。

**開発手法**: TDD（テスト駆動開発）
- 各フェーズで「テスト → 実装 → リファクタ」のサイクルを回す
- 小さなステップで確実に進める
- 機能単位で垂直スライス

2つの動作モードをサポート:
- **ブラウザ完結モード**: ブラウザ内で Durably を実行
- **サーバー連携モード**: サーバーで Durably を実行、クライアントは SSE で購読

---

## 1. パッケージ構成

### ディレクトリ構造

```
packages/durably-react/
├── src/
│   ├── index.ts              # ブラウザ完結モード
│   ├── client.ts             # サーバー連携モード
│   ├── context.tsx           # DurablyProvider
│   ├── hooks/                # ブラウザ完結モード用 hooks
│   ├── client/               # サーバー連携モード用 hooks
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
  }
}
```

---

## 2. コア側の要件

### 既存（実装済み）

- `durably.on()` が unsubscribe 関数を返す ✅
- `durably.register({ name: jobDef })` で JobHandle のオブジェクトを取得 ✅
- `run:progress` イベント ✅

### 新規（サーバー連携用）

1. `durably.getJob(jobName): JobHandle | undefined`
2. `durably.subscribe(runId): ReadableStream<DurablyEvent>`
3. `createDurablyHandler(durably)` (`@coji/durably/server`)

---

## 3. 実装フェーズ（TDD）

各フェーズで以下のサイクルを回す:
1. **Red**: テストを書く（失敗する）
2. **Green**: 最小限の実装で通す
3. **Refactor**: コードを整理

---

### Phase 1: 基盤構築

**目標**: パッケージ構造とビルド環境

**タスク**:
1. ディレクトリ作成
2. package.json（2エントリポイント）
3. tsconfig.json
4. tsup.config.ts
5. vitest.config.ts
6. 空のエクスポートでビルド確認

**成果物**: 空パッケージがビルドできる

---

### Phase 2: 型定義

**目標**: 共有型の定義

**タスク**:
`src/types.ts`:
```ts
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed'

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
```

**成果物**: 型定義ファイル

---

### Phase 3: DurablyProvider - 初期化 & StrictMode

**目標**: Provider が Durably を初期化できる、StrictMode で二重初期化しない

**テスト（Red）**:
```tsx
// tests/browser/provider.test.tsx
describe('DurablyProvider', () => {
  it('initializes Durably and provides isReady=true', async () => {
    const dialectFactory = () => createMockDialect()

    const { result } = renderHook(() => useDurably(), {
      wrapper: ({ children }) => (
        <DurablyProvider dialectFactory={dialectFactory}>
          {children}
        </DurablyProvider>
      ),
    })

    await waitFor(() => {
      expect(result.current.isReady).toBe(true)
    })
    expect(result.current.durably).not.toBeNull()
  })

  it('does not double-initialize in StrictMode', async () => {
    const dialectFactory = vi.fn(() => createMockDialect())

    render(
      <StrictMode>
        <DurablyProvider dialectFactory={dialectFactory}>
          <TestComponent />
        </DurablyProvider>
      </StrictMode>
    )

    await waitFor(() => {})
    expect(dialectFactory).toHaveBeenCalledTimes(1)
  })
})
```

**実装（Green）**:
- `src/context.tsx`: DurablyContext, DurablyProvider
- `src/hooks/use-durably.ts`: useDurably
- `useRef` で初期化フラグ管理（StrictMode 対応）

---

### Phase 4: DurablyProvider - オプション

**目標**: autoStart, autoMigrate オプション

**テスト（Red）**:
```tsx
it('respects autoStart=false', async () => {
  // start() が呼ばれないことを確認
})

it('respects autoMigrate=false', async () => {
  // migrate() が呼ばれないことを確認
})

it('passes options to createDurably', async () => {
  // createDurably に DurablyOptions が渡されることを確認
})
```

**実装（Green）**: オプション処理

---

### Phase 5: DurablyProvider - クリーンアップ

**目標**: アンマウント時に stop() が呼ばれる

**テスト（Red）**:
```tsx
it('calls stop() on unmount', async () => {
  const stopSpy = vi.fn()
  // ...
  unmount()
  expect(stopSpy).toHaveBeenCalled()
})
```

**実装（Green）**: cleanup 処理

---

### Phase 6: useJob - trigger

**目標**: trigger でジョブを実行し runId を返す

**テスト（Red）**:
```tsx
describe('useJob', () => {
  it('returns trigger function that executes job', async () => {
    const { result } = renderHook(() => useJob(testJob), { wrapper })

    await waitFor(() => expect(result.current.isReady).toBe(true))

    const { runId } = await result.current.trigger({ input: 'test' })

    expect(runId).toBeDefined()
    expect(typeof runId).toBe('string')
  })
})
```

**実装（Green）**:
- `src/hooks/use-job.ts`: trigger 関数のみ

---

### Phase 7: useJob - status 購読

**目標**: trigger 後に status が更新される（初期は `null`、trigger 時に `pending`）

**テスト（Red）**:
```tsx
it('updates status from pending to running to completed', async () => {
  const { result } = renderHook(() => useJob(testJob), { wrapper })

  await waitFor(() => expect(result.current.isReady).toBe(true))

  expect(result.current.status).toBeNull()

  act(() => {
    result.current.trigger({ input: 'test' })
  })

  expect(result.current.status).toBe('pending')

  await waitFor(() => {
    expect(result.current.status).toBe('completed')
  })
})
```

**実装（Green）**: イベント購読で status 更新

---

### Phase 8: useJob - output 取得

**目標**: 完了時に output が取得できる

**テスト（Red）**:
```tsx
it('provides output when completed', async () => {
  const { result } = renderHook(() => useJob(testJob), { wrapper })

  await result.current.trigger({ input: 'test' })

  await waitFor(() => {
    expect(result.current.output).toEqual({ success: true })
  })
})
```

**実装（Green）**: run:complete で output を設定

---

### Phase 9: useJob - error 取得

**目標**: 失敗時に error が取得できる

**テスト（Red）**:
```tsx
it('provides error when failed', async () => {
  const { result } = renderHook(() => useJob(failingJob), { wrapper })

  await result.current.trigger({ input: 'test' })

  await waitFor(() => {
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('Something went wrong')
  })
})
```

**実装（Green）**: run:fail で error を設定

---

### Phase 10: useJob - progress 購読

**目標**: progress が更新される

**テスト（Red）**:
```tsx
it('updates progress during execution', async () => {
  const { result } = renderHook(() => useJob(progressJob), { wrapper })

  result.current.trigger({ input: 'test' })

  await waitFor(() => {
    expect(result.current.progress).toEqual({
      current: 1,
      total: 3,
      message: 'Step 1',
    })
  })
})
```

**実装（Green）**: run:progress で progress を設定

---

### Phase 11: useJob - logs 購読

**目標**: logs が収集される

**テスト（Red）**:
```tsx
it('collects logs during execution', async () => {
  const { result } = renderHook(() => useJob(loggingJob), { wrapper })

  await result.current.trigger({ input: 'test' })

  await waitFor(() => {
    expect(result.current.logs).toHaveLength(2)
    expect(result.current.logs[0].message).toBe('Starting')
  })
})
```

**実装（Green）**: log:write で logs に追加

---

### Phase 12: useJob - boolean ヘルパー

**目標**: isRunning, isPending, isCompleted, isFailed

**テスト（Red）**:
```tsx
it('provides boolean helpers', async () => {
  const { result } = renderHook(() => useJob(testJob), { wrapper })

  expect(result.current.isRunning).toBe(false)
  expect(result.current.isPending).toBe(false)

  act(() => {
    result.current.trigger({ input: 'test' })
  })

  // pending 状態
  expect(result.current.isPending).toBe(true)

  await waitFor(() => {
    expect(result.current.isCompleted).toBe(true)
  })
})
```

**実装（Green）**: 派生状態を計算

---

### Phase 13: useJob - triggerAndWait

**目標**: 完了まで待つ関数

**テスト（Red）**:
```tsx
it('triggerAndWait resolves with output', async () => {
  const { result } = renderHook(() => useJob(testJob), { wrapper })

  await waitFor(() => expect(result.current.isReady).toBe(true))

  const { runId, output } = await result.current.triggerAndWait({ input: 'test' })

  expect(runId).toBeDefined()
  expect(output).toEqual({ success: true })
})

it('triggerAndWait rejects on failure', async () => {
  const { result } = renderHook(() => useJob(failingJob), { wrapper })

  await waitFor(() => expect(result.current.isReady).toBe(true))

  await expect(result.current.triggerAndWait({ input: 'test' })).rejects.toThrow(
    'Something went wrong'
  )
})
```

**実装（Green）**: `run:complete` で resolve、`run:fail` で reject

---

### Phase 14: useJob - reset

**目標**: 状態をリセット

**テスト（Red）**:
```tsx
it('reset clears all state', async () => {
  const { result } = renderHook(() => useJob(testJob), { wrapper })

  await result.current.trigger({ input: 'test' })
  await waitFor(() => expect(result.current.isCompleted).toBe(true))

  act(() => {
    result.current.reset()
  })

  expect(result.current.status).toBeNull()
  expect(result.current.output).toBeNull()
  expect(result.current.currentRunId).toBeNull()
})
```

**実装（Green）**: 初期状態に戻す

---

### Phase 15: useJob - initialRunId

**目標**: 既存 Run を購読

**テスト（Red）**:
```tsx
it('subscribes to existing run with initialRunId', async () => {
  // 先にジョブを実行して runId を取得
  const existingRunId = await triggerJobDirectly()

  const { result } = renderHook(
    () => useJob(testJob, { initialRunId: existingRunId }),
    { wrapper }
  )

  await waitFor(() => {
    expect(result.current.currentRunId).toBe(existingRunId)
  })
})
```

**実装（Green）**: 初期化時に購読開始

---

### Phase 16: useJob - クリーンアップ

**目標**: アンマウント時にリスナー解除

**テスト（Red）**:
```tsx
it('unsubscribes on unmount', async () => {
  const { result, unmount } = renderHook(() => useJob(testJob), { wrapper })

  await result.current.trigger({ input: 'test' })

  // まだ running 中にアンマウント
  unmount()

  // メモリリークがないことを確認（エラーが出ないこと）
})
```

**実装（Green）**: useEffect の cleanup で解除

---

### Phase 17: 共通ロジック抽出

**目標**: useJob と useJobRun/useJobLogs で共有するロジックを抽出

**タスク**:
- `src/hooks/use-run-subscription.ts`: Run 購読の共通ロジック
  - イベントリスナー登録/解除
  - 状態管理（status, output, error, logs, progress）

```ts
// 共通フック（内部用）
function useRunSubscription(runId: string | null) {
  // status, output, error, logs, progress の状態管理
  // durably.on() でイベント購読
  // runId が null の場合は購読しない（idle）
  // cleanup でリスナー解除
}
```

**Refactor**: useJob から共通部分を抽出

---

### Phase 18: useJobRun - 基本

**目標**: runId で購読

**テスト（Red）**:
```tsx
describe('useJobRun', () => {
  it('subscribes to run by id', async () => {
    const runId = await triggerJobDirectly()

    const { result } = renderHook(
      () => useJobRun({ runId }),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.status).not.toBeNull()
    })
  })

  it('handles null runId', () => {
    const { result } = renderHook(
      () => useJobRun({ runId: null }),
      { wrapper }
    )

    expect(result.current.status).toBeNull()
  })
})
```

**実装（Green）**: `src/hooks/use-job-run.ts`

---

### Phase 19: useJobLogs - 基本

**目標**: ログを購読

**テスト（Red）**:
```tsx
describe('useJobLogs', () => {
  it('collects logs for run', async () => {
    const runId = await triggerLoggingJob()

    const { result } = renderHook(
      () => useJobLogs({ runId }),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.logs.length).toBeGreaterThan(0)
    })
  })

  it('respects maxLogs limit', async () => {
    const { result } = renderHook(
      () => useJobLogs({ runId, maxLogs: 5 }),
      { wrapper }
    )

    // 多くのログを生成しても 5 件まで
    await waitFor(() => {
      expect(result.current.logs.length).toBeLessThanOrEqual(5)
    })
  })

  it('clear removes all logs', async () => {
    const { result } = renderHook(
      () => useJobLogs({ runId }),
      { wrapper }
    )

    await waitFor(() => expect(result.current.logs.length).toBeGreaterThan(0))

    act(() => {
      result.current.clear()
    })

    expect(result.current.logs).toHaveLength(0)
  })
})
```

**実装（Green）**: `src/hooks/use-job-logs.ts`

---

### Phase 20: コア拡張 - getJob

**目標**: 登録済みジョブを名前で取得

**テスト（Red）**:
```tsx
// packages/durably/tests/durably.test.ts
describe('getJob', () => {
  it('returns registered job by name', () => {
    const durably = createDurably({ dialect })
    durably.register({ testJob })

    const job = durably.getJob('test-job')

    expect(job).toBeDefined()
    expect(job?.name).toBe('test-job')
  })

  it('returns undefined for unknown job', () => {
    const durably = createDurably({ dialect })

    expect(durably.getJob('unknown')).toBeUndefined()
  })
})
```

**実装（Green）**: `packages/durably/src/durably.ts` に追加

---

### Phase 21: コア拡張 - subscribe

**目標**: Run のイベントを ReadableStream で返す

**テスト（Red）**:
```tsx
describe('subscribe', () => {
  it('returns ReadableStream of events', async () => {
    const durably = createDurably({ dialect })
    durably.register({ testJob })
    await durably.migrate()
    durably.start()

    const job = durably.getJob('test-job')!
    const run = await job.trigger({ input: 'test' })

    const stream = durably.subscribe(run.id)
    const reader = stream.getReader()

    const events: DurablyEvent[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      events.push(value)
    }

    expect(events.some(e => e.type === 'run:complete')).toBe(true)
  })
})
```

**実装（Green）**: `packages/durably/src/durably.ts` に追加

---

### Phase 22: コア拡張 - createDurablyHandler

**目標**: Web 標準の Request/Response ヘルパー

**テスト（Red）**:
```tsx
// packages/durably/tests/server.test.ts
describe('createDurablyHandler', () => {
  it('trigger returns runId', async () => {
    const handler = createDurablyHandler(durably)

    const request = new Request('http://localhost/api', {
      method: 'POST',
      body: JSON.stringify({ jobName: 'test-job', input: { value: 1 } }),
    })

    const response = await handler.trigger(request)
    const { runId } = await response.json()

    expect(runId).toBeDefined()
  })

  it('subscribe returns SSE stream', async () => {
    const handler = createDurablyHandler(durably)

    const request = new Request('http://localhost/api?runId=xxx')
    const response = handler.subscribe(request)

    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
  })
})
```

**実装（Green）**: `packages/durably/src/server.ts` 新規作成

---

### テストユーティリティ: createMockEventSource

**目標**: サーバー連携テストで使う EventSource モックを仕様化

**API 仕様**:
```ts
type MockEventSourceController = {
  instances: MockEventSourceInstance[]
  emit: (event: DurablyEvent) => void
  triggerError: (error: Error) => void
}

function createMockEventSource(opts?: { onClose?: () => void }): typeof EventSource & MockEventSourceController
```

**挙動**:
- `new EventSource(url)` でインスタンスを生成し `instances` に追加
- `emit(event)` は最新インスタンスへ `message` を配送（`data` は JSON 文字列）
- `triggerError(error)` は最新インスタンスへ `error` を配送
- `close()` が呼ばれたら `onClose` を実行

**実装（Green）**: `tests/client/mock-event-source.ts`

---

### Phase 23: サーバー連携 - useJob trigger

**目標**: fetch で trigger

**テスト（Red）**:
```tsx
// tests/client/use-job.test.tsx
describe('useJob (client)', () => {
  it('triggers via fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runId: 'test-run-id' }),
    })
    global.fetch = fetchMock

    const { result } = renderHook(() =>
      useJob({ api: '/api/durably', jobName: 'test-job' })
    )

    const { runId } = await result.current.trigger({ input: 'test' })

    expect(fetchMock).toHaveBeenCalledWith('/api/durably', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ jobName: 'test-job', input: { input: 'test' } }),
    }))
    expect(runId).toBe('test-run-id')
  })
})
```

**実装（Green）**: `src/client/use-job.ts`

---

### Phase 24: サーバー連携 - useJob SSE 購読

**目標**: EventSource で購読

**テスト（Red）**:
```tsx
it('subscribes via EventSource', async () => {
  const mockEventSource = createMockEventSource()
  global.EventSource = mockEventSource

  const { result } = renderHook(() =>
    useJob({ api: '/api/durably', jobName: 'test-job' })
  )

  await result.current.trigger({ input: 'test' })

  // SSE イベントをシミュレート
  mockEventSource.emit({ type: 'run:start', runId: 'xxx' })

  await waitFor(() => {
    expect(result.current.status).toBe('running')
  })

  mockEventSource.emit({ type: 'run:complete', runId: 'xxx', output: { ok: true } })

  await waitFor(() => {
    expect(result.current.status).toBe('completed')
    expect(result.current.output).toEqual({ ok: true })
  })
})
```

**実装（Green）**: EventSource 購読

---

### Phase 25: サーバー連携 - useJob 完全実装

**目標**: progress, logs, エラー処理

**テスト（Red）**:
```tsx
it('handles progress events', async () => {
  mockEventSource.emit({ type: 'run:progress', runId: 'xxx', progress: { current: 1, total: 3 } })

  await waitFor(() => {
    expect(result.current.progress).toEqual({ current: 1, total: 3 })
  })
})

it('handles log events', async () => {
  mockEventSource.emit({
    type: 'log:write',
    runId: 'xxx',
    level: 'info',
    message: 'Processing',
    data: null,
  })

  await waitFor(() => {
    expect(result.current.logs).toHaveLength(1)
    expect(result.current.logs[0].message).toBe('Processing')
  })
})

it('handles connection errors', async () => {
  mockEventSource.triggerError(new Error('Connection failed'))

  await waitFor(() => {
    expect(result.current.error).toBe('Connection failed')
  })
})
```

**実装（Green）**: 残りのイベント処理

---

### Phase 26: サーバー連携 - useJobRun

**目標**: runId で購読

**テスト（Red）**:
```tsx
describe('useJobRun (client)', () => {
  it('subscribes to run via SSE', async () => {
    const mockEventSource = createMockEventSource()
    global.EventSource = mockEventSource

    const { result } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'existing-run' })
    )

    mockEventSource.emit({ type: 'run:start', runId: 'existing-run' })

    await waitFor(() => {
      expect(result.current.status).toBe('running')
    })
  })

  it('does not subscribe when runId is null', () => {
    const mockEventSource = createMockEventSource()
    global.EventSource = mockEventSource

    renderHook(() => useJobRun({ api: '/api/durably', runId: null }))

    expect(mockEventSource.instances).toHaveLength(0)
  })

  it('closes EventSource on unmount', () => {
    const closeSpy = vi.fn()
    const mockEventSource = createMockEventSource({ onClose: closeSpy })

    const { unmount } = renderHook(() =>
      useJobRun({ api: '/api/durably', runId: 'xxx' })
    )

    unmount()
    expect(closeSpy).toHaveBeenCalled()
  })
})
```

**実装（Green）**: `src/client/use-job-run.ts`

---

### Phase 27: サーバー連携 - useJobLogs

**目標**: ログ購読

**テスト（Red）**:
```tsx
describe('useJobLogs (client)', () => {
  it('collects logs from SSE', async () => {
    const mockEventSource = createMockEventSource()
    global.EventSource = mockEventSource

    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'xxx' })
    )

    mockEventSource.emit({
      type: 'log:write',
      runId: 'xxx',
      level: 'info',
      message: 'Log 1',
    })
    mockEventSource.emit({
      type: 'log:write',
      runId: 'xxx',
      level: 'warn',
      message: 'Log 2',
    })

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2)
    })
  })

  it('respects maxLogs limit', async () => {
    const { result } = renderHook(() =>
      useJobLogs({ api: '/api/durably', runId: 'xxx', maxLogs: 2 })
    )

    // 3つのログを送信
    for (let i = 0; i < 3; i++) {
      mockEventSource.emit({ type: 'log:write', runId: 'xxx', message: `Log ${i}` })
    }

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2)
      expect(result.current.logs[0].message).toBe('Log 1') // 最初のログは削除される
    })
  })
})
```

**実装（Green）**: `src/client/use-job-logs.ts`

---

### Phase 28: エントリポイント整備

**目標**: 公開 API の整備

**タスク**:
1. `src/index.ts` - ブラウザ完結モード
2. `src/client.ts` - サーバー連携モード
3. ビルド確認

---

### Phase 29: 型テスト

**目標**: 型推論が正しく機能することを確認

**テスト**:
```ts
// tests/types.test.ts
import { expectTypeOf } from 'vitest'
import { useJob } from '../src'
import { testJob } from './fixtures'

describe('Type inference', () => {
  it('infers output type from job definition', () => {
    const { output, trigger } = useJob(testJob)

    // output は TOutput | null
    expectTypeOf(output).toEqualTypeOf<{ success: boolean } | null>()

    // trigger の引数は TInput
    expectTypeOf(trigger).parameter(0).toEqualTypeOf<{ taskId: string }>()
  })

  it('triggerAndWait returns typed output', async () => {
    const { triggerAndWait } = useJob(testJob)

    const result = await triggerAndWait({ taskId: '123' })

    expectTypeOf(result.output).toEqualTypeOf<{ success: boolean }>()
  })
})
```

**確認事項**:
- `useJob(jobDef)` で input/output の型が推論される
- `trigger()` の引数が型チェックされる
- `output` が正しい型で返される

---

### Phase 30: ドキュメント

**目標**: README と LLM ドキュメント

**タスク**:
1. `packages/durably-react/README.md`
2. `packages/durably-react/docs/llms.md`

---

### Phase 31: パブリッシュ準備

**目標**: npm パブリッシュの準備

**タスク**:
1. version を 0.1.0 に設定
2. CHANGELOG.md 作成
3. `pnpm publish --dry-run` で確認

---

## 4. 実装順序のまとめ

| Phase | 内容                              | TDD |
|-------|-----------------------------------|-----|
| 1-2   | 基盤・型定義                      | -   |
| 3-5   | DurablyProvider                   | ✅  |
| 6-16  | useJob（ブラウザ）                | ✅  |
| 17    | 共通ロジック抽出                  | -   |
| 18-19 | useJobRun, useJobLogs（ブラウザ） | ✅  |
| 20-22 | コア拡張                          | ✅  |
| 23-27 | サーバー連携 hooks                | ✅  |
| 28    | エントリポイント整備              | -   |
| 29    | 型テスト                          | ✅  |
| 30-31 | ドキュメント・パブリッシュ        | -   |

---

## 5. 完了条件

- [ ] 全フェーズでテストが先に書かれている
- [ ] 全テストがパスする
- [ ] ブラウザ完結モードの全フックが実装されている
- [ ] サーバー連携モードの全フックが実装されている
- [ ] コア側に `getJob`, `subscribe`, `createDurablyHandler` が追加されている
- [ ] 2つのエントリポイント (`.` と `./client`) が機能する
- [ ] StrictMode で正しく動作する
- [ ] 型推論が正しく機能する
- [ ] ドキュメントが整備されている
