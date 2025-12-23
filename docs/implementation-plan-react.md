# @coji/durably-react 実装計画

## 概要

この文書は `@coji/durably-react` パッケージの実装計画を定義する。仕様は `docs/spec-react.md` に基づく。

---

## 1. パッケージ構成

### ディレクトリ構造

```
packages/durably-react/
├── src/
│   ├── index.ts              # Public exports
│   ├── context.tsx           # DurablyContext & DurablyProvider
│   ├── hooks/
│   │   ├── use-durably.ts    # useDurably hook
│   │   ├── use-job.ts        # useJob hook
│   │   ├── use-job-run.ts    # useJobRun hook
│   │   └── use-job-logs.ts   # useJobLogs hook
│   └── types.ts              # Shared types
├── tests/
│   ├── provider.test.tsx     # DurablyProvider tests
│   ├── use-job.test.tsx      # useJob tests
│   ├── use-job-run.test.tsx  # useJobRun tests
│   ├── use-job-logs.test.tsx # useJobLogs tests
│   └── strict-mode.test.tsx  # React StrictMode tests
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
└── README.md
```

### package.json

```json
{
  "name": "@coji/durably-react",
  "version": "0.1.0",
  "description": "React bindings for Durably - step-oriented resumable batch execution",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"],
  "peerDependencies": {
    "@coji/durably": ">=0.4.0",
    "react": ">=18.0.0",
    "react-dom": ">=18.0.0"
  },
  "devDependencies": {
    "@coji/durably": "workspace:*",
    "@testing-library/react": "^16.x",
    "@types/react": "^19.x",
    "@types/react-dom": "^19.x",
    "@vitejs/plugin-react": "^5.x",
    "jsdom": "^27.x",
    "react": "^19.x",
    "react-dom": "^19.x",
    "sqlocal": "^0.16.x",
    "tsup": "^8.x",
    "typescript": "^5.x",
    "vitest": "^4.x"
  }
}
```

---

## 2. 実装フェーズ

### Phase 0: コア修正 - run:progress イベント追加

**目標**: `step.progress()` 呼び出し時に `run:progress` イベントを emit する

**タスク**:
1. `packages/durably/src/events.ts` に `RunProgressEvent` インターフェースを追加
   ```ts
   interface RunProgressEvent extends BaseEvent {
     type: 'run:progress'
     runId: string
     jobName: string
     progress: { current: number; total?: number; message?: string }
   }
   ```

2. `DurablyEvent` union 型に `RunProgressEvent` を追加

3. `EventType`, `AnyEventInput` の更新

4. `packages/durably/src/context.ts` の `progress()` メソッドを修正
   ```ts
   progress(current: number, total?: number, message?: string): void {
     const progressData = { current, total, message }
     // DB 更新
     storage.updateRun(run.id, { progress: progressData })
     // イベント emit
     emit({
       type: 'run:progress',
       runId: run.id,
       jobName: run.jobName,
       progress: progressData,
     })
   }
   ```

5. テスト追加: `run:progress` イベントが正しく emit されることを確認

6. ドキュメント更新
   - `website/api/events.md` - `run:progress` イベントをRun Eventsセクションに追加
   - `website/guide/events.md` - Available Events テーブルに追加
   - `packages/durably/docs/llms.md` - Events セクションに `run:progress` を追加

**成果物**:
- `run:progress` イベントが利用可能になる
- 既存のテストがパスする
- ドキュメントが更新されている

---

### Phase 1: 基盤構築

**目標**: パッケージ構造の作成とビルド環境の整備

**タスク**:
1. `packages/durably-react/` ディレクトリ作成
2. `package.json` 作成（peerDependencies 設定）
3. `tsconfig.json` 作成（durably と同様の設定）
4. `tsup.config.ts` 作成（ESM ビルド）
5. `vitest.config.ts` 作成（jsdom 環境）
6. `src/index.ts` に空のエクスポート
7. ビルド確認

**成果物**:
- 空の durably-react パッケージがビルドできる状態

### Phase 2: Context & Provider 実装

**目標**: DurablyProvider と useDurably の実装

**タスク**:
1. `src/types.ts` - 共有型定義
   - `DurablyContextValue`
   - `DurablyProviderProps`
   - `UseJobOptions`, `UseJobLogsOptions` など

2. `src/context.tsx` - DurablyContext & DurablyProvider
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

3. `src/hooks/use-durably.ts`
   - Context から値を取得するシンプルなフック
   - Provider 外で使用時はエラーをスロー

**テスト**:
- `tests/provider.test.tsx`
  - 正常な初期化フロー
  - StrictMode での二重マウント
  - autoStart/autoMigrate オプション
  - アンマウント時のクリーンアップ

### Phase 3: useJob 実装

**目標**: ジョブ実行と状態管理フック

**タスク**:
1. `src/hooks/use-job.ts`
   ```tsx
   interface UseJobState<TOutput> {
     status: RunStatus | null
     output: TOutput | null
     error: string | null
     logs: LogEntry[]
     progress: Progress | null
     currentRunId: string | null
   }

   function useJob<TName extends string, TInput, TOutput>(
     job: JobDefinition<TName, TInput, TOutput>,
     options?: UseJobOptions
   ): {
     isReady: boolean
     trigger: (input: TInput, opts?: TriggerOptions) => Promise<Run>
     triggerAndWait: (input: TInput, opts?: TriggerOptions) => Promise<{id: string, output: TOutput}>
     ...state,
     isRunning: boolean
     isPending: boolean
     isCompleted: boolean
     isFailed: boolean
     reset: () => void
   }
   ```

   **実装ポイント**:
   - `useDurably()` で context を取得
   - `useEffect` で `durably.register(job)` を実行
   - `useRef` で `JobHandle` を保持
   - `trigger()` 呼び出し時にイベントリスナーを登録
   - Run 完了/失敗時にリスナーを解除
   - アンマウント時にもリスナーを解除
   - `initialRunId` オプションで既存 Run を購読

2. イベント購読の実装
   ```tsx
   // trigger 内でリスナーを登録
   const unsubs = [
     durably.on('run:start', (e) => {
       if (e.runId === run.id) setState(s => ({...s, status: 'running'}))
     }),
     durably.on('run:complete', (e) => {
       if (e.runId === run.id) {
         setState(s => ({...s, status: 'completed', output: e.output}))
         cleanup()
       }
     }),
     durably.on('run:fail', (e) => {
       if (e.runId === run.id) {
         setState(s => ({...s, status: 'failed', error: e.error}))
         cleanup()
       }
     }),
     durably.on('log:write', (e) => {
       if (e.runId === run.id) {
         setState(s => ({...s, logs: [...s.logs, e]}))
       }
     }),
   ]
   ```

**テスト**:
- `tests/use-job.test.tsx`
  - trigger でジョブ実行
  - 状態更新（pending → running → completed）
  - エラー時の状態
  - ログ収集
  - 進捗更新
  - アンマウント時のリスナー解除
  - initialRunId による復元

### Phase 4: useJobRun & useJobLogs 実装

**目標**: 単独の Run 購読とログ購読フック

**タスク**:
1. `src/hooks/use-job-run.ts`
   - `runId` を受け取り、その Run の状態を購読
   - `useJob` の戻り値から `trigger` 系を除いたもの
   - DB ポーリングでステータス取得（イベントだけでは初期状態が取れないため）

   ```tsx
   function useJobRun(runId: string | null): {
     status: RunStatus | null
     output: unknown
     error: string | null
     logs: LogEntry[]
     progress: Progress | null
   }
   ```

2. `src/hooks/use-job-logs.ts`
   - グローバルまたは特定 Run のログを購読
   - `maxLogs` でログ数を制限

   ```tsx
   interface UseJobLogsOptions {
     runId?: string
     maxLogs?: number  // default: 100
   }

   function useJobLogs(options?: UseJobLogsOptions): {
     logs: LogEntry[]
     clear: () => void
   }
   ```

**テスト**:
- `tests/use-job-run.test.tsx`
  - 既存 Run の購読
  - null runId の扱い
  - 状態更新の購読

- `tests/use-job-logs.test.tsx`
  - ログ収集
  - maxLogs 制限
  - clear 機能
  - runId フィルタリング

### Phase 5: 型安全性とエッジケース

**目標**: 型推論の改善とエッジケース対応

**タスク**:
1. 型推論の確認
   - `useJob` の `output` が `TOutput` として型推論されること
   - `trigger` の引数が `TInput` として型推論されること

2. エッジケース対応
   - Provider 外での hook 使用時のエラーメッセージ
   - `isReady: false` 時の `trigger()` 呼び出しでエラー
   - 同じ `JobDefinition` を複数回登録した場合の動作
   - コンポーネントのアンマウント中に trigger が呼ばれた場合

3. SSR 対応
   - サーバーサイドでは `isReady: false` を返す
   - `typeof window === 'undefined'` チェック

### Phase 6: ドキュメントと例

**目標**: README とサンプルコードの整備

**タスク**:
1. `packages/durably-react/README.md` 作成
   - インストール方法
   - 基本的な使い方
   - API リファレンス

2. `examples/react` の更新
   - `@coji/durably-react` を使用するように変更
   - カスタム hook を削除

3. `packages/durably-react/docs/llms.md` 作成
   - LLM 向けドキュメント

### Phase 7: テストと品質保証

**目標**: 完全なテストカバレッジと品質確認

**タスク**:
1. テストの実行と修正
   - jsdom 環境でのテスト
   - StrictMode テスト

2. TypeScript 型チェック
3. ESLint / Biome チェック
4. ビルド確認

### Phase 8: パブリッシュ準備

**目標**: npm パブリッシュの準備（パブリッシュは手動で行う）

**タスク**:
1. version を 0.1.0 に設定
2. CHANGELOG.md 作成
3. ルートの package.json にスクリプト追加
   ```json
   "test:react-pkg": "pnpm --filter @coji/durably-react test"
   ```
4. 最終ビルド確認
5. dry-run で publish 確認 (`pnpm publish --dry-run`)

---

## 3. 技術的な決定事項

### StrictMode 対応

React 19 の StrictMode では、開発モードで useEffect が二重に実行される。以下のパターンで対応:

```tsx
function DurablyProvider({ dialectFactory, children }: Props) {
  const [state, setState] = useState({ durably: null, isReady: false, error: null })
  const initializedRef = useRef(false)

  useEffect(() => {
    // 二重初期化を防止
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
        if (!cancelled) {
          setState(s => ({ ...s, error: error as Error }))
        }
      }
    }

    init()

    return () => {
      cancelled = true
      durably.stop()
      // initializedRef はリセットしない（再マウント時に再初期化しない）
    }
  }, [dialectFactory])

  return <Context.Provider value={state}>{children}</Context.Provider>
}
```

### イベントリスナーのライフサイクル

```
trigger() 呼び出し
    ↓
リスナー登録 (run:start, run:complete, run:fail, log:write)
    ↓
イベント受信 → 状態更新
    ↓
run:complete または run:fail
    ↓
リスナー解除 (cleanup)

※ コンポーネントアンマウント時も cleanup を呼ぶ
```

### dialectFactory パターン

仕様書の説明通り、`dialect` を直接渡すと毎回新しいインスタンスが生成されてしまう問題を回避するため、`dialectFactory` 関数を受け取る:

```tsx
// 悪い例: 毎回新しい dialect が生成される
<DurablyProvider dialect={new SQLocalKysely('app.sqlite3').dialect}>

// 良い例: 一度だけ実行される
<DurablyProvider dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}>
```

---

## 4. コア側の要件確認

仕様書に記載のコア側要件を確認:

### 1. イベントリスナーの解除機能 ✅

現在のコードで確認済み:
```ts
// packages/durably/src/events.ts
export type Unsubscribe = () => void

// Durably.on() は Unsubscribe を返す
on<T extends EventType>(type: T, listener: EventListener<T>): Unsubscribe
```

### 2. register メソッド ✅

現在のコードで確認済み:
```ts
// packages/durably/src/durably.ts
register<TName extends string, TInput, TOutput>(
  jobDef: JobDefinition<TName, TInput, TOutput>,
): JobHandle<TName, TInput, TOutput>
```

→ コア側の変更は不要。現在のAPIで実装可能。

### 3. progress イベント ⚠️ (Phase 0 で対応)

現在のコアには `run:progress` イベントが存在しない。Phase 0 で追加する。

**追加するイベント**:
```ts
interface RunProgressEvent extends BaseEvent {
  type: 'run:progress'
  runId: string
  jobName: string
  progress: { current: number; total?: number; message?: string }
}
```

これにより、React 側でリアルタイムに progress を購読できるようになる。

---

## 5. 依存関係

```
@coji/durably-react
├── @coji/durably  (peer dependency >= 0.4.0)
├── react          (peer dependency >= 18.0.0)
└── react-dom      (peer dependency >= 18.0.0)

開発時:
├── kysely         (テストで必要)
├── sqlocal        (テストで必要)
└── zod            (テストで必要)
```

---

## 6. 公開 API

```ts
// @coji/durably-react

// Context & Provider
export { DurablyProvider } from './context'
export type { DurablyProviderProps } from './types'

// Hooks
export { useDurably } from './hooks/use-durably'
export { useJob } from './hooks/use-job'
export { useJobRun } from './hooks/use-job-run'
export { useJobLogs } from './hooks/use-job-logs'

// Types (re-export convenience types)
export type {
  UseJobOptions,
  UseJobResult,
  UseJobRunResult,
  UseJobLogsOptions,
  UseJobLogsResult,
} from './types'
```

---

## 7. 実装順序のまとめ

| Phase | 内容 | 依存 |
|-------|------|------|
| **0** | **コア修正: run:progress イベント追加** | - |
| 1 | 基盤構築 | Phase 0 |
| 2 | DurablyProvider, useDurably | Phase 1 |
| 3 | useJob | Phase 2 |
| 4 | useJobRun, useJobLogs | Phase 2 |
| 5 | 型安全性、エッジケース | Phase 3, 4 |
| 6 | ドキュメント、例 | Phase 5 |
| 7 | テスト、品質保証 | Phase 6 |
| 8 | パブリッシュ準備 | Phase 7 |

---

## 8. リスクと対策

| リスク | 対策 |
|--------|------|
| StrictMode での予期せぬ動作 | 二重マウントテストを十分に行う |
| イベントリスナーのメモリリーク | useEffect cleanup で確実に解除 |
| 型推論が複雑で失敗 | ジェネリクスの型テストを追加 |
| ブラウザ環境でのテスト失敗 | jsdom で基本テスト、必要なら Playwright |

---

## 9. 完了条件

- [ ] コア: `run:progress` イベントが追加されている
- [ ] すべてのフック（useDurably, useJob, useJobRun, useJobLogs）が実装されている
- [ ] DurablyProvider が StrictMode で正しく動作する
- [ ] 型推論が正しく機能する（TypeScript エラーなし）
- [ ] テストがすべてパスする
- [ ] ドキュメントが整備されている
- [ ] examples/react が新パッケージを使用するように更新されている
- [ ] `pnpm publish --dry-run` が成功する
