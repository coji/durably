# 将来仕様: AI Agent ワークフロー拡張 (v2)

> **⚠️ 注意: これは将来拡張の構想ドキュメントです。**
>
> v1 で `subscribe()` は実装済み。本ドキュメントでは v2 以降の拡張機能を検討します。

## 背景

LLM を使った AI Agent のワークフローを durably で実装したい。

**ユースケース例**:
- ブラウザから AI Agent を起動
- ストリーミングで進捗をリアルタイム表示
- 途中でリロード/離脱しても、戻ってきたときに実行中なら再接続できる
- 長時間実行（数分〜数十分）に対応

---

## v1 で実装済みの機能

### `subscribe()` - リアルタイム購読

v1 で実装済み。Run の実行中に発火されるイベントを `ReadableStream<DurablyEvent>` として取得できる。

```ts
const stream = durably.subscribe(runId)

const reader = stream.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break

  switch (value.type) {
    case 'run:start':
      console.log('Run started')
      break
    case 'step:complete':
      console.log(`Step ${value.stepName} completed`)
      break
    case 'run:complete':
      console.log('Run completed:', value.output)
      break
    case 'run:fail':
      console.error('Run failed:', value.error)
      break
  }
}
```

**現在の制約**:
- イベントはメモリ上のみ（永続化されない）
- 再接続時に過去のイベントは取得できない
- `step.stream()` によるトークン単位のストリーミングは未対応

---

## v2 拡張案

### 1. ストリーミングステップ (`step.stream()`)

通常の `step.run()` に加えて、ストリーミング出力をサポートするステップを追加。

```ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const aiAgent = defineJob({
  name: 'ai-agent',
  input: z.object({ prompt: z.string() }),
  output: z.object({ response: z.string() }),
  run: async (step, payload) => {
    // 通常のステップ（永続化される）
    const context = await step.run('fetch-context', async () => {
      return await fetchRelevantDocuments(payload.prompt)
    })

    // ストリーミングステップ
    const response = await step.stream('generate-response', async (emit) => {
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
  },
})
```

**設計ポイント**:
- `emit()` で中間データを送信（永続化はしない）
- ステップ完了時に戻り値が永続化される
- 再実行時は完了済みステップをスキップ（通常と同じ）

### 2. イベントログの永続化

粗いイベント（step:*, run:*）を永続化し、再接続時に再生可能にする。

```sql
-- events テーブル（新規追加）
CREATE TABLE events (
  id TEXT PRIMARY KEY,        -- ULID
  run_id TEXT NOT NULL,
  step_name TEXT,
  type TEXT NOT NULL,         -- 'step:start', 'step:complete', 'run:complete', etc.
  data TEXT,                  -- JSON
  sequence INTEGER NOT NULL,  -- 順序保証用
  created_at TEXT NOT NULL,

  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE INDEX idx_events_run_sequence ON events(run_id, sequence);
```

**永続化するイベント**:
- `run:start`, `run:complete`, `run:fail`
- `step:start`, `step:complete`, `step:fail`
- `run:progress`
- `log:write`

**永続化しないイベント**:
- `stream`（トークン単位の emit）- メモリのみで直接配信

### 3. 再接続サポート (`resumeFrom`)

```ts
interface SubscribeOptions {
  resumeFrom?: number  // 最後に受信した sequence
}

// 再接続時に使用
const stream = durably.subscribe(runId, { resumeFrom: lastSequence })
```

**再接続フロー**:
1. クライアントが `resumeFrom: lastSequence` で接続
2. サーバーは `sequence > lastSequence` のイベントを DB から取得して送信
3. 以降はリアルタイムでイベントを配信

### 4. チェックポイント（長時間実行対応）

LLM Agent は数分〜数十分かかることがある。途中状態を細かく保存する仕組み。

```ts
const response = await step.stream('generate-response', async (emit, checkpoint) => {
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

---

## API 設計案

### StepContext の拡張

```ts
interface StepContext {
  // v1 (実装済み)
  readonly runId: string
  run<T>(name: string, fn: () => Promise<T>): Promise<T>
  progress(current: number, total?: number, message?: string): void
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }

  // v2 (新規)
  stream<T>(
    name: string,
    fn: (emit: EmitFn, checkpoint?: CheckpointFn) => Promise<T>
  ): Promise<T>
}

type EmitFn = (data: unknown) => void
type CheckpointFn = (state: unknown) => Promise<void>
```

### DurablyEvent の拡張

```ts
// v1 イベント (実装済み)
type DurablyEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | RunProgressEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
  | WorkerErrorEvent

// v2 追加イベント
interface StreamEvent extends BaseEvent {
  type: 'stream'
  runId: string
  stepName: string
  data: unknown  // emit() に渡されたデータ
}
```

### subscribe() の拡張

```ts
// v1 (実装済み)
subscribe(runId: string): ReadableStream<DurablyEvent>

// v2 (拡張)
subscribe(runId: string, options?: SubscribeOptions): ReadableStream<DurablyEvent>

interface SubscribeOptions {
  resumeFrom?: number  // 最後に受信した sequence
}
```

---

## 実装フェーズ案

### Phase A: step.stream() 基本実装

- `step.stream()` の実装（emit のみ、checkpoint なし）
- `StreamEvent` の追加
- `subscribe()` で `stream` イベントを配信

### Phase B: イベント永続化と再接続

- `events` テーブルの追加
- 粗いイベント（step:*, run:*）の永続化
- `resumeFrom` による再接続サポート
- Storage インターフェースの拡張:
  ```ts
  createEvent(event: DurablyEvent): Promise<void>
  getEvents(runId: string, afterSequence?: number): Promise<DurablyEvent[]>
  ```

### Phase C: チェックポイント

- `checkpoint()` の実装
- チェックポイントからの再開サポート
- TTL によるイベントログのクリーンアップ

---

## 設計上の考慮事項

### DB負荷とストリーミング戦略

LLM のトークン単位ストリーミングは 1秒に数十〜数百回の emit が発生しうる。
毎回 DB に書き込むのは現実的ではない。

**採用方針**: イベントログは粗いイベントのみ永続化

| イベント       | 永続化 | 備考                 |
|----------------|--------|----------------------|
| `run:*`        | ✅     | 再接続時に再生       |
| `step:*`       | ✅     | 再接続時に再生       |
| `run:progress` | ✅     | 進捗状態の復元       |
| `log:write`    | ✅     | ログの永続化         |
| `stream`       | ❌     | メモリのみ、直接配信 |

**トレードオフ**:
- 再接続時にトークン単位の再生は不可
- 進行中ステップがあれば、そのステップは最初からやり直し
- ステップを細かく分ければ損失は最小限

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
// jobs.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const codingAssistant = defineJob({
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
  run: async (step, payload) => {
    // Step 1: タスク分析
    const analysis = await step.stream('analyze-task', async (emit) => {
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

    step.progress(1, 3, 'Task analyzed')

    // Step 2: コード検索
    const relevantFiles = await step.run('search-code', async () => {
      return await searchCodebase(payload.codebase, analysis.keywords)
    })

    step.progress(2, 3, 'Code searched')

    // Step 3: 変更生成
    const changes = await step.stream('generate-changes', async (emit) => {
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
  },
})

// client.ts - subscribe() で購読
const stream = durably.subscribe(run.id)

const reader = stream.getReader()
while (true) {
  const { done, value } = await reader.read()
  if (done) break

  switch (value.type) {
    case 'stream':
      switch (value.data.type) {
        case 'thinking':
          appendToThinkingPanel(value.data.text)
          break
        case 'diff-chunk':
          appendToDiffViewer(value.data.file, value.data.text)
          break
        case 'status':
          updateStatus(value.data.message)
          break
      }
      break
    case 'run:progress':
      updateProgressBar(value.progress)
      break
    case 'run:complete':
      showFinalResult(value.output)
      break
  }
}
```

---

## まとめ

| 機能                 | 状態           | 複雑度 | 備考                         |
|----------------------|----------------|--------|------------------------------|
| `subscribe()`        | ✅ v1 実装済み | -      | ReadableStream を返す        |
| `step.stream()`      | 🔜 v2 Phase A  | 中     | AI Agent の基本要件          |
| イベント永続化       | 🔜 v2 Phase B  | 中     | 粗いイベントのみ DB 保存     |
| `resumeFrom` 再接続  | 🔜 v2 Phase B  | 低     | 永続化されたイベントから再生 |
| `checkpoint()`       | 🔜 v2 Phase C  | 高     | 長時間実行に必要             |

v1 の `subscribe()` をベースに、段階的に拡張していく。
