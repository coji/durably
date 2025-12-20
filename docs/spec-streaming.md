# 将来仕様検討: AI Agent ワークフロー対応

## 背景

LLM を使った AI Agent のワークフローを durably で実装したい。

**ユースケース例**:
- ブラウザから AI Agent を起動
- ストリーミングで進捗をリアルタイム表示
- 途中でリロード/離脱しても、戻ってきたときに実行中なら再接続できる
- 長時間実行（数分〜数十分）に対応

---

## 課題

### 現仕様の制約

1. **ストリーミング非対応**: 現在の設計はリクエスト/レスポンス型。ステップ完了時にのみ状態が永続化される。

2. **リアルタイム通知の欠如**: イベントシステムは同一プロセス内のみ。ブラウザタブ間やサーバー→クライアントへのプッシュ機構がない。

3. **LLM 特有の要件**:
   - トークン単位のストリーミング出力
   - 中間結果の表示（思考過程、ツール呼び出し）
   - 長時間実行中の heartbeat

---

## 拡張案

### 1. ストリーミングステップ (`ctx.stream()`)

通常の `ctx.run()` に加えて、ストリーミング出力をサポートするステップを追加。

```ts
const aiAgent = durably.defineJob({
  name: 'ai-agent',
  input: z.object({ prompt: z.string() }),
  output: z.object({ response: z.string() }),
}, async (ctx, payload) => {

  // 通常のステップ（永続化される）
  const context = await ctx.run('fetch-context', async () => {
    return await fetchRelevantDocuments(payload.prompt)
  })

  // ストリーミングステップ
  const response = await ctx.stream('generate-response', async (emit) => {
    const stream = await llm.chat({
      messages: [{ role: 'user', content: payload.prompt }],
      context,
    })

    let fullResponse = ''
    for await (const chunk of stream) {
      fullResponse += chunk.text
      emit({ type: 'token', text: chunk.text })

      // ツール呼び出しも emit
      if (chunk.toolCall) {
        emit({ type: 'tool-call', name: chunk.toolCall.name })
      }
    }

    return fullResponse // これが永続化される
  })

  return { response }
})
```

**設計ポイント**:
- `emit()` で中間データを送信（永続化はしない）
- ステップ完了時に戻り値が永続化される
- 再実行時は完了済みステップをスキップ（通常と同じ）

### 2. リアルタイム購読 (`subscribe()`)

実行中の Run にリアルタイムで接続する API。Web Streams API の `ReadableStream` を使用する。

```ts
// subscribe() は ReadableStream を返す
const stream = await durably.subscribe(runId)

// ReadableStream として消費
for await (const event of stream) {
  switch (event.type) {
    case 'stream':
      appendToUI(event.data.text)
      break
    case 'step:complete':
      updateProgress(event.stepName)
      break
    case 'run:complete':
      showResult(event.output)
      break
  }
}
```

**メリット**:
- ブラウザネイティブ API（追加ライブラリ不要）
- バックプレッシャー対応（消費側が遅いと生成を待つ）
- `for await...of` で直感的に消費
- `pipeThrough()` でトランスフォーム可能
- Node.js でも同じ API（`ReadableStream` は標準化済み）

**実装イメージ**:

```ts
// subscribe の実装
async function subscribe(runId: string, options?: SubscribeOptions): Promise<ReadableStream<DurablyEvent>> {
  // 初期イベントを先に取得（再接続時は resumeFrom 以降）
  const initialEvents = await getEvents(runId, options?.resumeFrom)

  return new ReadableStream({
    start(controller) {
      // 取得済みの初期イベントをプッシュ
      for (const event of initialEvents) {
        controller.enqueue(event)
      }
    },

    async pull(controller) {
      // 新しいイベントをポーリングまたはリッスン
      const event = await waitForNextEvent(runId)
      if (event.type === 'run:complete' || event.type === 'run:fail') {
        controller.enqueue(event)
        controller.close()
      } else {
        controller.enqueue(event)
      }
    },

    cancel() {
      // クリーンアップ
    }
  })
}
```

**再接続の実装**:

```ts
// クライアント側で最後のイベントを記録
let lastSequence = 0

async function consumeWithReconnect(runId: string) {
  while (true) {
    try {
      const stream = await durably.subscribe(runId, {
        resumeFrom: lastSequence
      })

      for await (const event of stream) {
        lastSequence = event.sequence
        handleEvent(event)

        if (event.type === 'run:complete' || event.type === 'run:fail') {
          return // 正常終了
        }
      }
    } catch (error) {
      // 接続エラー時はリトライ
      await sleep(1000)
    }
  }
}
```

### 3. イベントログの永続化

ストリーミングイベントを再接続時に再生するため、イベントログを永続化。

```sql
-- events テーブル（新規追加）
CREATE TABLE events (
  id TEXT PRIMARY KEY,        -- ULID
  run_id TEXT NOT NULL,
  step_name TEXT,
  type TEXT NOT NULL,         -- 'stream', 'step:start', 'step:complete', etc.
  data TEXT,                  -- JSON
  sequence INTEGER NOT NULL,  -- 順序保証用
  created_at TEXT NOT NULL,   -- イベント型では timestamp として公開

  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX idx_events_run_sequence ON events(run_id, sequence);
```

**注**: DBカラム名 `created_at` は、イベント型では `timestamp` フィールドとして公開される（v1 と同じパターン）。

**再接続フロー**:
1. クライアントが `resumeFrom: lastSequence` で接続
2. サーバーは `sequence > lastSequence` のイベントを送信
3. 以降はリアルタイムでイベントを配信

### 4. チェックポイント（長時間実行対応）

LLM Agent は数分〜数十分かかることがある。途中状態を細かく保存する仕組み。

```ts
const response = await ctx.stream('generate-response', async (emit, checkpoint) => {
  let fullResponse = ''

  for await (const chunk of stream) {
    fullResponse += chunk.text
    emit({ type: 'token', text: chunk.text })

    // 一定間隔でチェックポイント
    if (shouldCheckpoint()) {
      await checkpoint({ partialResponse: fullResponse })
    }
  }

  return fullResponse
})
```

**再開時の挙動**:
- チェックポイントがあれば、そこから再開
- LLM に「続きを生成」のプロンプトを送る（アプリケーション側の責務）

### 5. ブラウザ環境での実装

ブラウザでは Web Worker + BroadcastChannel でタブ間通信。

```ts
// メインタブ（実行側）
const durably = createDurably({ dialect })
durably.on('stream', (event) => {
  // BroadcastChannel で他のタブに通知
  channel.postMessage(event)
})

// 別タブ（表示側）
const channel = new BroadcastChannel('durably-events')
channel.onmessage = (event) => {
  updateUI(event.data)
}
```

**制約**:
- 同一オリジン内のみ
- タブが全て閉じると通知も停止
- 永続化されたイベントログから復元は可能

---

## API 設計案

### JobHandle の拡張

```ts
interface JobHandle<TName, TInput, TOutput> {
  // 型情報（v1と同じ）
  readonly name: TName
  readonly $types: {
    input: TInput
    output: TOutput
  }

  // 既存
  trigger(input: TInput, options?: TriggerOptions): Promise<Run<TOutput>>
  getRun(id: string): Promise<Run<TOutput> | null>
  getRuns(filter?: RunFilter): Promise<Run<TOutput>[]>

  // 新規: ReadableStream を返す（初期イベント取得のため非同期）
  subscribe(runId: string, options?: SubscribeOptions): Promise<ReadableStream<DurablyEvent>>
}

interface SubscribeOptions {
  resumeFrom?: number  // 最後に受信した sequence
}

// subscribe() は ReadableStream を返す
type DurablyEventStream = ReadableStream<DurablyEvent>

type DurablyEvent =
  // v1 イベント
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
  // v2 追加イベント
  | StreamEvent

interface StreamEvent {
  type: 'stream'
  runId: string
  stepName: string
  sequence: number
  data: unknown  // emit() に渡されたデータ
  timestamp: string
}
```

### JobContext の拡張

```ts
interface JobContext {
  // 既存
  run<T>(name: string, fn: () => Promise<T>): Promise<T>
  log: Logger
  setProgress(progress: Progress): void

  // 新規
  stream<T>(
    name: string,
    fn: (emit: EmitFn, checkpoint: CheckpointFn) => Promise<T>
  ): Promise<T>
}

type EmitFn = (data: unknown) => void
type CheckpointFn = (state: unknown) => Promise<void>
```

---

## 実装フェーズ案

### Phase A: イベントログ基盤（v0.2）

- `events` テーブルの追加
- `ctx.stream()` の基本実装（emit のみ、checkpoint なし）
- `subscribe()` の実装（ReadableStream を返す、ポーリングベース）

### Phase B: 再接続とタブ間通知（v0.3）

- `resumeFrom` による再接続（イベントログから再生）
- BroadcastChannel によるタブ間通知（ブラウザ、ポーリング不要に）
- ヘルパー関数 `subscribeWithReconnect()` の提供

### Phase C: チェックポイント（v0.4）

- `checkpoint()` の実装
- 部分的な再開のサポート
- TTL によるイベントログのクリーンアップ

---

## 検討事項

### DB負荷とストリーミング戦略

LLM のトークン単位ストリーミングは 1秒に数十〜数百回の emit が発生しうる。
毎回 DB に書き込むのは現実的ではない。

#### 採用する方針: イベントログは粗いイベントのみ永続化

```ts
// DB に永続化するイベント（再接続時に再生可能）
step:start
step:complete
step:fail
run:complete
run:fail
progress 更新（setProgress）

// DB に書かないイベント（メモリのみ、直接配信）
stream（トークン単位の emit）
```

**トレードオフ**:
- 再接続時にトークン単位の再生は不可
- 進行中ステップがあれば、そのステップは最初からやり直し
- ステップを細かく分ければ損失は最小限

**実装イメージ**:

```ts
ctx.stream('generate-response', async (emit) => {
  for await (const chunk of llmStream) {
    // emit はメモリのみ → 接続中のクライアントに即座に配信
    emit({ type: 'token', text: chunk.text })
  }
  // ステップ完了時に最終結果が DB に保存される
  return fullResponse
})
```

**再接続時の挙動**:

1. クライアントが再接続
2. DB から `step:complete` までのイベントを再生
3. 進行中のステップがあれば、ステップ完了を待つ
4. 完了していないステップの途中経過（トークン）は失われる

これは許容できる制約。理由:
- LLM の応答は再生成可能（決定論的ではないが、意味的には同等）
- ステップを細かく分ければ損失は小さい
- DB負荷を劇的に削減できる

### ストレージ容量

永続化するイベントは粗いものに限定されるため、容量問題は軽減される。

- デフォルトで TTL（例: 24時間）を設定
- Run 完了後にイベントを削除するオプション

### セキュリティ

- `subscribe()` の認可（runId を知っていれば接続可能でよいか？）
- イベントデータに機密情報が含まれる可能性

---

## ユースケース例: AI Coding Assistant

```ts
const codingAssistant = durably.defineJob({
  name: 'coding-assistant',
  input: z.object({
    task: z.string(),
    codebase: z.string(),
  }),
  output: z.object({
    plan: z.string(),
    changes: z.array(z.object({
      file: z.string(),
      diff: z.string(),
    })),
  }),
}, async (ctx, payload) => {

  // Step 1: タスク分析
  const analysis = await ctx.stream('analyze-task', async (emit) => {
    const stream = await llm.chat({
      messages: [
        { role: 'system', content: 'Analyze the coding task...' },
        { role: 'user', content: payload.task },
      ],
    })

    let result = ''
    for await (const chunk of stream) {
      result += chunk.text
      emit({ type: 'thinking', text: chunk.text })
    }
    return JSON.parse(result)
  })

  ctx.setProgress({ current: 1, total: 3, message: 'Task analyzed' })

  // Step 2: コード検索
  const relevantFiles = await ctx.run('search-code', async () => {
    return await searchCodebase(payload.codebase, analysis.keywords)
  })

  ctx.setProgress({ current: 2, total: 3, message: 'Code searched' })

  // Step 3: 変更生成
  const changes = await ctx.stream('generate-changes', async (emit) => {
    const changes = []

    for (const file of analysis.filesToModify) {
      emit({ type: 'status', message: `Modifying ${file}...` })

      const stream = await llm.chat({
        messages: [
          { role: 'system', content: 'Generate code changes...' },
          { role: 'user', content: `File: ${file}\nTask: ${analysis.plan}` },
        ],
      })

      let diff = ''
      for await (const chunk of stream) {
        diff += chunk.text
        emit({ type: 'diff-chunk', file, text: chunk.text })
      }

      changes.push({ file, diff })
    }

    return changes
  })

  return { plan: analysis.plan, changes }
})

// クライアント側
const run = await codingAssistant.trigger({
  task: 'Add user authentication',
  codebase: '/path/to/repo',
})

const stream = await codingAssistant.subscribe(run.id)

for await (const event of stream) {
  switch (event.type) {
    case 'stream':
      switch (event.data.type) {
        case 'thinking':
          appendToThinkingPanel(event.data.text)
          break
        case 'diff-chunk':
          appendToDiffViewer(event.data.file, event.data.text)
          break
        case 'status':
          updateStatus(event.data.message)
          break
      }
      break
    case 'run:complete':
      showFinalResult(event.output)
      break
  }
}
```

---

## まとめ

| 機能 | 優先度 | 複雑度 | 備考 |
|------|--------|--------|------|
| `ctx.stream()` | 高 | 中 | AI Agent の基本要件 |
| `subscribe()` (ReadableStream) | 高 | 低 | Web Streams API、追加依存なし |
| 粗いイベントのみ永続化 | 高 | 低 | step:*, run:* のみ DB 保存。トークン単位はメモリのみ |
| `resumeFrom` 再接続 | 高 | 低 | 完了済みステップから再生 |
| `checkpoint()` | 中 | 高 | 長時間実行に必要 |
| BroadcastChannel | 低 | 低 | ブラウザ専用の最適化 |

v0.1 (現在の計画) の完成後、Phase A から段階的に実装していく。
