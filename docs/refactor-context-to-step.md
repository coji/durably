# Refactoring Plan: `context` → `step`

## Background

現在の API では `context` という名前でジョブコンテキストを渡しているが、初見で分かりにくい。

```ts
// 現在
durably.defineJob("myJob", async (context, payload) => {
  const result = await context.run("step1", () => fetchData())
  context.progress(1, 10)
  context.log.info("Processing...")
})
```

`context.run` が何を意味するか直感的ではない。

## Research

### Inngest の API

```ts
inngest.createFunction(
  { id: "my-function" },
  { event: "user/created" },
  async ({ event, step }) => {
    const result = await step.run("fetch-data", async () => {
      return fetch("...").json()
    })
    await step.sleep("wait", "1 hour")
  }
)
```

- `step.run()` - ステップ実行
- `step.sleep()` - スリープ
- オブジェクト分割代入で `{ event, step }` を受け取る

### Trigger.dev v4 の API

```ts
task({
  id: "parent-task",
  run: async (payload, { ctx }) => {
    // ctx は実行情報（runId, environment など）
    // step は別の仕組み
  }
})
```

## Decision

Inngest スタイルを採用し、`step` に全てをまとめる。

```ts
// 新しい API
durably.defineJob("myJob", async (step, payload) => {
  step.runId                                    // 現在の run ID
  const result = await step.run("step1", fn)    // ステップ実行
  step.progress(1, 10)                          // 進捗報告
  step.log.info("Processing...")                // ログ
})
```

### 理由

1. `step.run` は「ステップを実行する」と読める
2. Inngest ユーザーに馴染みやすい
3. シンプル - 1つのオブジェクトに全て集約

## Migration Plan

### Phase 1: 型定義の変更

1. `JobContext` → `StepContext` にリネーム
2. `JobFunction` の引数名を `context` → `step` に変更

対象ファイル:

- `packages/durably/src/job.ts` - 型定義

### Phase 2: 実装の変更

1. `createJobContext` → `createStepContext` にリネーム
2. Worker 内の変数名を `context` → `step` に変更

対象ファイル:

- `packages/durably/src/context.ts` - ファクトリ関数名変更
- `packages/durably/src/worker.ts` - 変数名変更
- `packages/durably/src/index.ts` - エクスポート名変更

### Phase 3: テストの更新

全て `context` → `step` に変更:

- `packages/durably/tests/shared/step.shared.ts` (17箇所)
- `packages/durably/tests/shared/recovery.shared.ts` (15箇所)
- `packages/durably/tests/shared/log.shared.ts` (14箇所)
- `packages/durably/tests/shared/run-api.shared.ts` (8箇所)
- `packages/durably/tests/shared/concurrency.shared.ts` (4箇所)
- `packages/durably/tests/shared/plugin.shared.ts` (6箇所)
- `packages/durably/tests/shared/worker.shared.ts` (1箇所)

### Phase 4: Examples の更新

- `examples/node/basic.ts` (3箇所)
- `examples/browser/src/main.ts` (3箇所)
- `examples/react/src/App.tsx` (3箇所)

### Phase 5: ドキュメントの更新

メイン:

- `README.md` (2箇所)
- `packages/durably/README.md` (2箇所)
- `CLAUDE.md` (1箇所)
- `docs/spec.md` (多数)
- `docs/spec-streaming.md` (多数)

Website (EN):

- `website/api/context.md` → `website/api/step.md` にリネーム
- `website/api/define-job.md`
- `website/api/events.md`
- `website/api/index.md`
- `website/guide/getting-started.md`
- `website/guide/jobs-and-steps.md`
- `website/guide/resumability.md`
- `website/guide/events.md`
- `website/guide/react.md`
- `website/guide/index.md`

Website (JA):

- `website/ja/api/context.md` → `website/ja/api/step.md` にリネーム
- `website/ja/api/define-job.md`
- `website/ja/api/events.md`
- `website/ja/api/index.md`
- `website/ja/guide/getting-started.md`
- `website/ja/guide/jobs-and-steps.md`
- `website/ja/guide/resumability.md`
- `website/ja/guide/events.md`
- `website/ja/guide/react.md`
- `website/ja/guide/index.md`

## Breaking Changes

- `JobContext` → `StepContext` (型名変更)
- `createJobContext` → `createStepContext` (内部関数名変更)
- 引数名 `context` → `step` (ユーザーコード影響あり)

## Checklist

### Phase 1: 型定義 ✅

- [x] `packages/durably/src/job.ts`: `JobContext` → `StepContext` にリネーム
- [x] `packages/durably/src/job.ts`: `JobFunction` の引数名を `context` → `step` に変更

### Phase 2: 実装 ✅

- [x] `packages/durably/src/context.ts`: `createJobContext` → `createStepContext` にリネーム
- [x] `packages/durably/src/worker.ts`: `context` → `step` に変更
- [x] `packages/durably/src/index.ts`: `JobContext` → `StepContext` にエクスポート変更

### Phase 3: テスト ✅

- [x] `packages/durably/tests/shared/step.shared.ts`
- [x] `packages/durably/tests/shared/recovery.shared.ts`
- [x] `packages/durably/tests/shared/log.shared.ts`
- [x] `packages/durably/tests/shared/run-api.shared.ts`
- [x] `packages/durably/tests/shared/concurrency.shared.ts`
- [x] `packages/durably/tests/shared/plugin.shared.ts`
- [x] `packages/durably/tests/shared/worker.shared.ts`

### Phase 4: Examples ✅

- [x] `examples/node/basic.ts`
- [x] `examples/browser/src/main.ts`
- [x] `examples/react/src/App.tsx`

### Phase 5: ドキュメント ✅

- [x] `README.md`
- [x] `packages/durably/README.md`
- [x] `CLAUDE.md`
- [x] `docs/spec.md`
- [x] `docs/spec-streaming.md`
- [x] `website/api/context.md` → `website/api/step.md` にリネーム
- [x] `website/ja/api/context.md` → `website/ja/api/step.md` にリネーム
- [x] その他 website ドキュメント内の `context` → `step` 変更
- [x] `.vitepress/config.ts` のナビゲーション更新

### Phase 6: 最終確認 ✅

- [x] `pnpm validate` が通ることを確認 (230 tests passing)
- [ ] CHANGELOG.md に記載 (リリース時に追加)
