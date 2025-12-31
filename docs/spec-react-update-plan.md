# spec-react.md 修正プラン

## 概要

`docs/spec-react.md` と実装の差異を解消するための修正プランです。

---

## 1. RunStatus 型に cancelled を追加

**現状 (L386):**
```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed'
```

**修正後:**
```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
```

---

## 2. useJob (browser mode) に autoResume / followLatest オプションを追加

**現状 (L249-253):**
```
| 引数 | 型 | 説明 |
|------|-----|------|
| `jobDefinition` | `JobDefinition` | ジョブ定義 |
| `options.initialRunId` | `string` | 初期購読 Run ID |
```

**修正後:**
```
| 引数 | 型 | 説明 |
|------|-----|------|
| `jobDefinition` | `JobDefinition` | ジョブ定義 |
| `options.initialRunId` | `string` | 初期購読 Run ID |
| `options.autoResume` | `boolean` | pending/running の Run を自動再開（デフォルト: true） |
| `options.followLatest` | `boolean` | 新しい Run 開始時に自動切替（デフォルト: true） |
```

---

## 3. client mode useJob の initialRunId ✅ 実装済み

**現状 (L357-364):**
```
| オプション     | 型       | 必須 | 説明                        |
|----------------|----------|------|-----------------------------|
| `api`          | `string` | Yes  | API エンドポイント          |
| `jobName`      | `string` | Yes  | ジョブ名                    |
| `initialRunId` | `string` | -    | 初期購読 Run ID（再接続用） |
```

→ **仕様通り実装済み。変更不要。**

---

## 4. useRuns hook を追加

「API 仕様」セクションに以下を追加:

### ブラウザ完結モード

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
} = useRuns(options?)
```

| オプション | 型 | 説明 |
|------------|-----|------|
| `jobName` | `string` | ジョブ名でフィルタ |
| `status` | `RunStatus` | ステータスでフィルタ |
| `limit` | `number` | 1ページの件数（デフォルト: 20） |
| `realtime` | `boolean` | リアルタイム更新（デフォルト: true） |

### サーバー連携モード

```tsx
import { useRuns } from '@coji/durably-react/client'

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
} = useRuns({
  api: '/api/durably',
  jobName?: 'my-job',
  status?: 'completed',
  limit?: 20,
  realtime?: true,
})
```

---

## 5. useRunActions hook を追加（client mode のみ）

「サーバー連携モード」セクションに以下を追加:

```tsx
import { useRunActions } from '@coji/durably-react/client'

const { retry, cancel, isLoading, error } = useRunActions({
  api: '/api/durably',
})

// 使用例
await retry(runId)   // 失敗した Run を再実行
await cancel(runId)  // 実行中の Run をキャンセル
```

| 戻り値 | 型 | 説明 |
|--------|-----|------|
| `retry` | `(runId: string) => Promise<void>` | Run を再実行 |
| `cancel` | `(runId: string) => Promise<void>` | Run をキャンセル |
| `isLoading` | `boolean` | アクション実行中 |
| `error` | `string \| null` | エラーメッセージ |

---

## 6. createDurablyClient / createJobHooks を追加

「サーバー連携モード」セクションに以下を追加:

### 型安全クライアントファクトリ（推奨）

```tsx
import { createDurablyClient, createJobHooks } from '@coji/durably-react/client'
import type { processTask, syncUsers } from './jobs'

// 方法1: createDurablyClient
const client = createDurablyClient<{
  'process-task': typeof processTask
  'sync-users': typeof syncUsers
}>({ api: '/api/durably' })

const { trigger, status } = client.useJob('process-task')
await trigger({ taskId: '123' })  // 型安全

// 方法2: createJobHooks
const { useProcessTask, useSyncUsers } = createJobHooks<{
  'process-task': typeof processTask
  'sync-users': typeof syncUsers
}>({ api: '/api/durably' })

const { trigger, status } = useProcessTask()
```

---

## 7. DurablyHandler の追加メソッドを文書化

**現状 (L292-293):**
```ts
handler.trigger(request: Request): Promise<Response>  // POST
handler.subscribe(request: Request): Response         // GET (SSE)
```

**修正後:**
```ts
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

---

## 8. API ルーティングを実装に合わせて更新

**現状 (L298-301):**
```
| エンドポイント | メソッド | リクエスト | レスポンス |
|---------------|---------|-----------|-----------|
| `/api/durably` | POST | `{ jobName, input }` | `{ runId }` |
| `/api/durably?runId=xxx` | GET | - | SSE stream |
```

**修正後:**
```
| エンドポイント | メソッド | リクエスト | レスポンス |
|---------------|---------|-----------|-----------|
| `{basePath}/trigger` | POST | `{ jobName, input, idempotencyKey?, concurrencyKey? }` | `{ runId }` |
| `{basePath}/subscribe?runId=xxx` | GET | - | SSE stream (single run) |
| `{basePath}/runs` | GET | `?jobName=&status=&limit=&offset=` | `Run[]` |
| `{basePath}/run?runId=xxx` | GET | - | `Run` or 404 |
| `{basePath}/retry?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/cancel?runId=xxx` | POST | - | `{ success: true }` |
| `{basePath}/runs/subscribe` | GET | `?jobName=` | SSE stream (run updates) |
```

---

## 9. 将来拡張セクションの更新

キャンセル API は実装済みのため、将来拡張から削除し、実装済みとして記載する。

**現状 (L629-642):**
```
### キャンセル API

Run のキャンセル機能を追加予定。
...
```

**修正後:**
「将来拡張」セクションからキャンセル API を削除し、上記の useRunActions として文書化済みであることを確認。

---

## 10. サーバー側使用例の更新

**現状 (L109-125):**
```ts
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

**修正後:**
```ts
const handler = createDurablyHandler(durably)

// 全ルートを自動処理（推奨）
export async function loader({ request }: LoaderFunctionArgs) {
  return handler.handle(request, '/api/durably')
}

export async function action({ request }: ActionFunctionArgs) {
  return handler.handle(request, '/api/durably')
}
```

---

## 修正優先度

| 優先度 | 項目 | 理由 |
|--------|------|------|
| 高 | API ルーティング更新 | 実装と大きく乖離 |
| 高 | DurablyHandler メソッド追加 | 実装と大きく乖離 |
| 高 | useRuns hook 追加 | 実装済みだが未文書化 |
| 高 | useRunActions hook 追加 | 実装済みだが未文書化 |
| 中 | RunStatus に cancelled 追加 | 型の不一致 |
| 中 | useJob オプション更新 | 機能の不一致 |
| 中 | createDurablyClient 追加 | 推奨 API だが未文書化 |
| 低 | 将来拡張セクション更新 | 実装済み機能の整理 |
