# 将来仕様: Human-in-the-Loop（HITL）最適化

> **⚠️ 注意: これは将来拡張の構想ドキュメントです。**
>
> 個人開発者でも迷わず使える “最高の DX” を最優先にした HITL 仕様。

## 目的

- エージェントループに **人の承認/修正/却下** を自然に差し込める
- 最小の実装で **すぐ動く**。あとから拡張できる
- “何が起きたか” が **短いコードと少ない画面** でわかる

## 非目標

- エンタープライズ向けの複雑な権限管理
- 分散キューや高スループット最適化

---

## DX 原則

1. **書きやすい**: `await ctx.human()` だけで止められる
2. **迷わない**: “待ち” は `waiting_human` で一意に表現
3. **つなげやすい**: `resume(token)` で外部から再開できる
4. **あとから育つ**: 監査ログ/通知/UI は後付けできる

---

## 仕様案（最小構成）

### 1) API

```ts
// Step 内で人の承認を要求
const decision = await ctx.human({
  summary: "請求書の金額が想定内か確認してください",
  schema: z.object({
    approve: z.boolean(),
    note: z.string().optional(),
  }),
  timeoutMs: 1000 * 60 * 60 * 24, // 24h
});
```

```ts
// 再開側（UI/CLI/外部サービスから）
await durably.resume(token, { approve: true, note: "OK" });
```

**DX ポイント**
- `summary` は UI/通知でそのまま表示できる  
- `schema` は任意。最初は JSON で受けてよい  
- `timeoutMs` は “放置回収” のために使える

---

### 2) 状態遷移

```text
pending -> running -> waiting_human -> running -> completed
                           |                |
                           |----> failed ---|
```

- `waiting_human` になったら **安全に停止**
- `resume(token)` で同じ run を継続

---

### 3) DB 追加項目（最小）

**runs**
- `status`: `waiting_human` を追加
- `wait_token`: 再開用トークン
- `wait_reason`: `"human"` 固定でよい
- `wait_summary`: 人に見せる文
- `wait_schema`: 文字列化したスキーマ（任意）
- `wait_deadline_at`: 期限（任意）

**run_steps**
- `step_type`: `human` を追加
- `human_payload`: 入力（JSON）
- `human_decision`: `approved | rejected | edited`（任意）

---

### 4) resume の挙動

1. `wait_token` が一致し、`status = waiting_human` を確認
2. `run_steps` に human 結果を保存
3. `status = running` に戻す
4. 次の step から継続

---

## Durably API 仕様（統一案）

### Core API

```ts
// Step 内で human wait を発生させる
type HumanOptions = {
  summary: string
  schema?: unknown // JSON Schema / Zod などのメタ
  timeoutMs?: number
}

type HumanResult<T = unknown> = T

interface StepContext {
  human<T = unknown>(options: HumanOptions): Promise<HumanResult<T>>
}

// waiting_human を再開
interface Durably {
  resume<T = unknown>(token: string, payload?: T): Promise<{
    runId: string
    success: true
  }>
}
```

### データモデル

**Run**
- `status`: `waiting_human` を追加
- `wait_token`: 再開トークン（必須）
- `wait_summary`: 人に見せる文（必須）
- `wait_schema`: JSON Schema の文字列（任意）
- `wait_deadline_at`: 期限（**新規 run では必須**）

**RunStep**
- `step_type`: `human` | `null`（`null` は既存の通常 step）
- `human_payload`: 承認/修正の入力
- `human_decision`: `approved | rejected | edited`（任意）

---

## HTTP API（createDurablyHandler 拡張）

### 既存 API の拡張

- `GET /runs?status=waiting_human`
  - 返却は `wait_*` を含む Run
  - **デフォルトでは `wait_token` を返さない**
  - `includeToken=true` のときのみ返す

**token 取得例**

```ts
// GET /api/durably/runs?status=waiting_human&includeToken=true
const res = await fetch('/api/durably/runs?status=waiting_human&includeToken=true')
const runs = await res.json()

// token を使って再開
const run = runs[0]
await fetch('/api/durably/resume', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    token: run.wait_token,
    payload: { decision: 'approved', note: 'OK' },
  }),
})
```

**CLI 例**

```bash
# waiting_human の一覧
durably runs --status waiting_human --include-token

# token を使って再開
durably resume <token> --json '{"decision":"approved","note":"OK"}'
```

**React 例**

```tsx
import { useEffect, useState } from 'react'

type WaitingRun = {
  id: string
  wait_token: string
  wait_summary: string
}

export function HumanInbox() {
  const [runs, setRuns] = useState<WaitingRun[]>([])

  useEffect(() => {
    fetch('/api/durably/runs?status=waiting_human&includeToken=true')
      .then((r) => r.json())
      .then((data) => setRuns(data))
  }, [])

  async function approve(run: WaitingRun) {
    await fetch('/api/durably/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: run.wait_token,
        payload: { decision: 'approved' },
      }),
    })
  }

  return (
    <div>
      <h2>Waiting</h2>
      {runs.map((run) => (
        <div key={run.id}>
          <div>{run.wait_summary}</div>
          <button onClick={() => approve(run)}>Approve</button>
        </div>
      ))}
    </div>
  )
}
```

### 新規 API

**POST /resume**
- body: `{ token: string, payload?: object }`
- response: `{ runId: string, success: true }`
- **同一 token の再利用は `409 Conflict`**

---

## 権限/認証

- 認証/権限は **アプリ側で実装**する
- `/runs?includeToken=true` と `/resume` は必ず認可を通す
- token は **短期の capability** として扱う

---

## 実装前に確定する方針（決定）

### token 生成

- **UUID v4** を使用（例: `crypto.randomUUID()`）
- `wait_deadline_at` を **新規 run で必須**とし、トークンは期限付き
- トークンは **1 回限り**で無効化

### timeout の扱い

- 期限切れは **`failed` + `reason = 'human_timeout'`**
- `retry(runId)` で **再度待機に戻せる**（再通知しやすい）
- `timeoutMs` が未指定の場合は **デフォルト 24h**
  - 既存データ互換のため、DB カラムは `NULL` を許容
  - ただし **新規 run は常に期限を設定**する

### status 一覧（Run）

- `pending | running | waiting_human | completed | failed | cancelled`

### HTTP エラー形式（共通）

```json
{
  "success": false,
  "error": "already_resumed",
  "message": "Resume token already used"
}
```

- `POST /resume` の二重実行は **409 + error=already_resumed**

### Job Versioning との統合

- Phase 1: HITL 単体で完結（job_hash 互換性チェックなし）
- Phase 2: Job Versioning 実装時に `resume` へチェックを追加

---

## 実装ガイド（差分の具体化）

### DB マイグレーション（version 2）

**runs に追加**
- `wait_token` (text, null)
- `wait_reason` (text, null)
- `wait_summary` (text, null)
- `wait_schema` (text, null)
- `wait_deadline_at` (text, null) // 既存互換のため NULL 許容

**steps に追加**
- `step_type` (text, null) // NULL は通常 step, human は HITL step
- `human_payload` (text, null)
- `human_decision` (text, null)

**DDL 例（SQLite）**

```sql
ALTER TABLE durably_runs ADD COLUMN wait_token TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_reason TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_summary TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_schema TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_deadline_at TEXT;

ALTER TABLE durably_steps ADD COLUMN step_type TEXT;
ALTER TABLE durably_steps ADD COLUMN human_payload TEXT;
ALTER TABLE durably_steps ADD COLUMN human_decision TEXT;
```

**互換性**
- 既存 run は `wait_*` が `NULL` のまま動作
- `step_type` が `NULL` の場合は既存 step とみなす

### ctx.human() 実装の流れ（擬似コード）

```ts
async function human(options) {
  // 1) wait_token 生成 + wait_* 保存
  // 2) status = waiting_human に遷移
  // 3) run_steps に step_type=human を追加（必要なら）
  // 4) ここで実行を止める（worker は次回以降に継続）
  throw new WaitHumanSignal(options)
}
```

### Worker における WaitHumanSignal の扱い

```ts
try {
  await runJobStep(...)
} catch (err) {
  if (err instanceof WaitHumanSignal) {
    // failed 扱いにしない
    // status は waiting_human のまま維持
    return
  }
  // 既存の失敗処理
  await storage.failRun(...)
}
```

### resume() のトランザクション境界

**必須の一貫性**
1. token 検証 + `status = waiting_human` の確認
2. `run_steps` に human 結果を保存
3. `status = running` に戻す
4. （Phase 2）job_hash 互換性チェック（Job Versioning と同時導入）

**推奨**
- 可能なら **DB トランザクション**で包む
- トランザクションが無い場合は **楽観的更新**
  - `WHERE status = 'waiting_human' AND wait_token = ?` を条件に更新

### replay 時の ctx.human() の挙動

- run を再実行すると同じ step が再評価される
- `ctx.human()` は **既存の human step があれば即解決**する
  - `run_steps` に `step_type=human` があり、`human_payload` が存在すれば
    それを返して継続
  - 存在しなければ新規に `waiting_human` を作成

### Worker の変更点（擬似コード）

```ts
// 既存: pending -> running を処理
const run = await storage.getNextPendingRun(...)

// 追加: waiting_human の期限切れを回収
const expired = await storage.getExpiredHumanWaitRun(now)
if (expired) {
  await storage.failRun(expired.id, 'human_timeout')
}
```

### 追加イベント

- `run:wait_human` (runId, summary, deadline)
- `run:resume` (runId, decision)

---

## HTTP エラーコード（詳細）

- `POST /resume`
  - `404` token 不正
  - `409` already_resumed
  - `410` expired

## React Client API（server 連携）

### Hooks（提案）

```ts
import { useWaitingRuns, useResume } from '@coji/durably-react/client'

const { runs, reload } = useWaitingRuns({ api: '/api/durably' })
const { resume, isResuming } = useResume({ api: '/api/durably' })

await resume({ token, payload: { decision: 'approved' } })
```

**Hook の型（案）**

```ts
type ResumeInput = {
  token: string
  payload?: { decision: 'approved' | 'rejected' | 'edited'; [key: string]: unknown }
}

type UseResumeResult = {
  resume: (input: ResumeInput) => Promise<{ runId: string; success: true }>
  isResuming: boolean
}
```

### ブラウザ完結モード

- `useWaitingRuns()` は `durably.getRuns({ status: 'waiting_human' })` に委譲
- `resume()` は `durably.resume()` を直接呼ぶ

---

## 体験設計（個人開発者向け）

- **CLI 最優先**: `durably runs --waiting` と `durably resume <token> --json '{...}'`
- **UI は後で**: 最初は CLI だけでも成立する設計
- **通知は任意**: Webhook 連携を小さく用意（Slack/Discord など）

---

## 体験設計（画面遷移・具体タスク）

### 想定タスク例: CSV インポートの人手確認

- ユーザーが CSV をアップロード
- 自動解析・整形を実行
- 人が内容を確認して承認/修正/却下
- 承認後に本処理を実行

### 画面遷移（React Router v7 を想定）

1. **アップロード画面**
   - CSV をアップロード
   - 解析中の進捗を表示
   - 完了後「確認待ち一覧」へ遷移

2. **確認待ち一覧（My Inbox）**
   - `waiting_human` の run を一覧表示
   - `summary` と簡易プレビューを表示
   - クリックで詳細画面へ

3. **詳細確認画面（Review）**
   - 差分プレビュー / ハイライト
   - 操作: **Approve / Edit / Reject**
   - Edit は修正フォームを表示

4. **実行中 / 完了画面**
   - SSE で進捗を表示
   - 完了後に結果/ログを表示

### API 連携（最小）

- `POST /api/durably/trigger`
  - CSV をアップロード後に run を作成
- `GET /api/durably/runs?status=waiting_human`
  - Inbox 一覧取得（`wait_token`, `wait_summary` を含む）
- `POST /api/durably/resume`
  - `{ token, payload }` で承認/修正/却下
- `GET /api/durably/subscribe?runId=...`
  - 実行中の進捗を購読

---

## 推奨のガードレール

- `waiting_human` は **タイムアウトを推奨**（無期限は避ける）
- `timeoutMs` 超過は **`failed` + `reason = 'human_timeout'`**
- `resume` は **1 回限り**（二重実行防止 / 再実行は 409）
- `payload` は `decision: 'approved' | 'rejected' | 'edited'` を **明示で含める**
- `wait_schema` は **JSON Schema 文字列**で保存する
- `resume` payload は **サイズ制限** を設ける

---

## 将来拡張（Phase 2）

- **HITL UI**: 承認/修正/却下を提供する簡易ダッシュボード
- **Decision log**: 誰がいつ何をしたかの監査ログ
- **Policy**: “必ず人を通す step” を型で表現

---

## Open Questions
なし（本仕様で確定）
