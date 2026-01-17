# 将来仕様: Human-in-the-Loop（HITL）最適化（シンプル版）

> **⚠️ 注意: これは将来拡張の構想ドキュメントです。**
>
> 「とにかく分かりやすく、最短で使える」ことを最優先にした HITL 仕様。

## 目的

- エージェントループに **人の入力** を自然に差し込める
- 最小の実装で **すぐ動く**。あとから拡張できる
- “何が起きたか” が **短いコードと少ない画面** でわかる

## 非目標

- エンタープライズ向けの複雑な権限管理
- 分散キューや高スループット最適化

---

## DX 原則

1. **書きやすい**: `await ctx.human()` だけで止められる
2. **迷わない**: “待ち” は `waiting_human` で一意に表現
3. **つなげやすい**: `resume(runId)` で外部から再開できる
4. **あとから育つ**: 監査ログ/通知/UI は後付けできる

---

## 仕様案（最小構成）

### 1) API

```ts
// Step 内で人の入力を要求
const decision = await ctx.human({
  message: "請求書の金額が想定内か確認してください",
  schema: z.object({
    decision: z.enum(['approved', 'rejected', 'edited']),
    note: z.string().optional(),
  }),
  timeoutMs: 1000 * 60 * 60 * 24, // 24h
})
```

```ts
// 再開側（UI/CLI/外部サービスから）
await durably.resume(runId, { decision: 'approved', note: "OK" })
```

**DX ポイント**
- `message` は UI/通知でそのまま表示できる
- `schema` は任意。最初は JSON で受けてよい
- `timeoutMs` は “放置回収” のために使える
- token は使わず、**runId で再開**する
- `payload` の基本形は `decision`（`approved | rejected | edited`）を推奨

---

### 2) 状態遷移

```text
pending -> running -> waiting_human -> running -> completed
                           |                |
                           |----> failed ---|
```

- `waiting_human` になったら **安全に停止**
- `resume(runId)` で同じ run を継続

---

### 3) DB 追加項目（最小）

**runs**
- `status`: `waiting_human` を追加
- `wait_message`: 人に見せる文
- `wait_schema`: 文字列化したスキーマ（任意）
- `wait_deadline_at`: 期限（任意）

**run_steps**
- `step_type`: `human` を追加
- `human_payload`: 入力（JSON）

---

### 4) resume の挙動

1. `runId` が一致し、`status = waiting_human` を確認
2. `run_steps` に human 結果を保存
3. `status = running` に戻す
4. 次の step から継続

---

## Durably API 仕様（統一案）

### Core API

```ts
// Step 内で human wait を発生させる
type HumanOptions = {
  message: string
  schema?: unknown // JSON Schema / Zod などのメタ
  timeoutMs?: number
}

type HumanResult<T = unknown> = T

interface StepContext {
  human<T = unknown>(options: HumanOptions): Promise<HumanResult<T>>
}

// waiting_human を再開
interface Durably {
  resume<T = unknown>(runId: string, payload: T): Promise<{
    runId: string
    success: true
  }>
}
```

### データモデル

**Run**
- `status`: `waiting_human` を追加
- `wait_message`: 人に見せる文（必須）
- `wait_schema`: JSON Schema の文字列（任意）
- `wait_deadline_at`: 期限（新規 run では必須）

**RunStep**
- `step_type`: `human` | `null`（`null` は既存の通常 step）
- `human_payload`: 承認/修正の入力

---

## HTTP API（createDurablyHandler 拡張）

### 既存 API の拡張

- `GET /runs?status=waiting_human`
  - 返却は `wait_*` を含む Run

**再開例**

```ts
// GET /api/durably/runs?status=waiting_human
const res = await fetch('/api/durably/runs?status=waiting_human')
const runs = await res.json()

// runId を使って再開
const run = runs[0]
await fetch('/api/durably/resume', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    runId: run.id,
    payload: { decision: 'approved', note: 'OK' },
  }),
})
```

**CLI 例**

```bash
# waiting_human の一覧
durably runs --status waiting_human

# runId を使って再開
durably resume <runId> --json '{"decision":"approved","note":"OK"}'
```

**React 例**

```tsx
import { useEffect, useState } from 'react'

type WaitingRun = {
  id: string
  wait_message: string
}

export function HumanInbox() {
  const [runs, setRuns] = useState<WaitingRun[]>([])

  useEffect(() => {
    fetch('/api/durably/runs?status=waiting_human')
      .then((r) => r.json())
      .then((data) => setRuns(data))
  }, [])

  async function approve(run: WaitingRun) {
    await fetch('/api/durably/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: run.id,
        payload: { decision: 'approved' },
      }),
    })
  }

  return (
    <div>
      <h2>Waiting</h2>
      {runs.map((run) => (
        <div key={run.id}>
          <div>{run.wait_message}</div>
          <button onClick={() => approve(run)}>Approve</button>
        </div>
      ))}
    </div>
  )
}
```

### 新規 API

**POST /resume**
- body: `{ runId: string, payload: object }`
- response: `{ runId: string, success: true }`
- **waiting 以外の状態は `409 Conflict`**

---

## 権限/認証

- 認証/権限は **アプリ側で実装**する
- `/runs?status=waiting_human` と `/resume` は必ず認可を通す
- token を使わない前提のため、**API 認証は必須**

---

## Security Considerations（要点）

Durably は認証方式に依存しない。**重要なのは認可**である。

- **runId は秘密ではない**前提で設計する（IDだけで再開を許可しない）
- `GET /runs?status=waiting_human` は **ユーザー/組織で必ずフィルタ**
- `POST /resume` は **対象runの所有/権限チェック必須**
- `payload` は `ctx.human({ schema })` に沿って **サーバー側で検証**
- `run:resume` には **actorId / ip / userAgent** を記録（監査）

参考の認証基盤例: Better Auth / Clerk / Supabase / Firebase / NextAuth.js

---

## 実装前に確定する方針（決定）

### timeout の扱い

- 期限切れは **`failed` + `reason = 'human_timeout'`**
- `retry(runId)` で **再度待機に戻せる**（再通知しやすい）
- `timeoutMs` が未指定の場合は **デフォルト 24h**
  - DB カラムは `NULL` を許容
  - ただし **新規 run は常に期限を設定**する

### status 一覧（Run）

- `pending | running | waiting_human | completed | failed | cancelled`

### HTTP エラー形式（共通）

```json
{
  "success": false,
  "error": "invalid_state",
  "message": "Run is not waiting_human"
}
```

- `POST /resume` の不正状態は **409 + error=invalid_state**

---

## Job Versioning との統合

- Phase 1: HITL 単体で完結（job_hash 互換性チェックなし）
- Phase 2: Job Versioning 実装時に `resume` へチェックを追加

---

## 実装ガイド（差分の具体化）

### DB マイグレーション（version 2）

**runs に追加**
- `wait_message` (text, null)
- `wait_schema` (text, null)
- `wait_deadline_at` (text, null) // 既存互換のため NULL 許容

**steps に追加**
- `step_type` (text, null) // NULL は通常 step, human は HITL step
- `human_payload` (text, null)

**DDL 例（SQLite）**

```sql
ALTER TABLE durably_runs ADD COLUMN wait_message TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_schema TEXT;
ALTER TABLE durably_runs ADD COLUMN wait_deadline_at TEXT;

ALTER TABLE durably_steps ADD COLUMN step_type TEXT;
ALTER TABLE durably_steps ADD COLUMN human_payload TEXT;
```

**互換性**
- 既存 run は `wait_*` が `NULL` のまま動作
- `step_type` が `NULL` の場合は既存 step とみなす

### ctx.human() 実装の流れ（擬似コード）

```ts
async function human(options) {
  // 1) wait_* 保存
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
1. `runId` 検証 + `status = waiting_human` の確認
2. `run_steps` に human 結果を保存
3. `status = running` に戻す
4. （Phase 2）job_hash 互換性チェック（Job Versioning と同時導入）

**推奨**
- 可能なら **DB トランザクション**で包む
- トランザクションが無い場合は **楽観的更新**
  - `WHERE status = 'waiting_human' AND id = ?` を条件に更新

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

- `run:wait_human` (runId, message, deadline)
- `run:resume` (runId, payload)

---

## HTTP エラーコード（詳細）

- `POST /resume`
  - `404` runId 不正
  - `409` invalid_state
  - `410` expired

---

## React Client API（server 連携）

### Hooks（提案）

```ts
import { useHumanWaits } from '@coji/durably-react/client'

const { runs, reload, respond } = useHumanWaits({ api: '/api/durably' })

await respond(runId, { decision: 'approved' })
```
