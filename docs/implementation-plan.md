# Durably 実装計画

テストドリブン開発（TDD）で段階的に実装を進める計画書。

## 方針

- 各フェーズで「テストを書く → 実装する → リファクタリング」のサイクルを回す
- 最小限の機能から始めて、段階的に拡張していく
- 各フェーズは独立してマージ可能な単位とする
- **Node.js (Turso/libSQL) と ブラウザ (SQLocal/OPFS) の両環境でテストする**

---

## Monorepo 構成

pnpm workspace を使った monorepo 構成を採用する。

### ディレクトリ構成

```
durably/
├── packages/
│   └── durably/              # コアライブラリ
│       ├── src/
│       ├── tests/
│       │   ├── node/
│       │   ├── browser/
│       │   └── shared/
│       ├── package.json
│       ├── vitest.config.ts
│       └── vitest.browser.config.ts
├── examples/
│   ├── node/                 # Node.js サンプル
│   │   ├── package.json      # "@coji/durably": "workspace:*"
│   │   └── basic.ts
│   └── browser/              # ブラウザサンプル
│       ├── package.json      # "@coji/durably": "workspace:*"
│       ├── vite.config.ts
│       ├── index.html
│       └── src/main.ts
├── pnpm-workspace.yaml
├── package.json              # ルート (scripts, devDependencies)
└── tsconfig.json             # ベース設定
```

### pnpm-workspace.yaml

```yaml
packages:
  - 'packages/*'
  - 'examples/*'
```

### ルート package.json

```json
{
  "name": "durably-monorepo",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "test:node": "pnpm --filter @coji/durably test:node",
    "test:browser": "pnpm --filter @coji/durably test:browser",
    "dev:node": "pnpm --filter example-node dev",
    "dev:browser": "pnpm --filter example-browser dev"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

---

## テスト環境のセットアップ

### packages/durably/package.json

```json
{
  "name": "@coji/durably",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./plugins": {
      "types": "./dist/plugins/index.d.ts",
      "import": "./dist/plugins/index.js"
    }
  },
  "scripts": {
    "build": "tsup",
    "test": "pnpm test:node && pnpm test:browser",
    "test:node": "vitest run --config vitest.config.ts",
    "test:browser": "vitest run --config vitest.browser.config.ts",
    "lint": "biome check .",
    "format": "prettier --write ."
  },
  "peerDependencies": {
    "kysely": ">=0.27.0"
  },
  "dependencies": {
    "ulidx": "^2.4.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "kysely": "^0.27.0",
    "@libsql/client": "^0.14.0",
    "@libsql/kysely-libsql": "^0.7.0",
    "sqlocal": "^0.12.0",
    "vitest": "^3.0.0",
    "@vitest/browser-playwright": "^3.0.0",
    "playwright": "^1.49.0",
    "tsup": "^8.5.0",
    "@biomejs/biome": "^2.3.0",
    "prettier": "^3.7.0",
    "prettier-plugin-organize-imports": "^4.3.0",
    "typescript": "^5.7.0"
  }
}
```

### テスト構成

```txt
packages/durably/tests/
├── node/                    # Node.js 環境テスト (Turso/libSQL)
│   ├── migrate.test.ts
│   ├── job.test.ts
│   └── ...
├── browser/                 # ブラウザ環境テスト (SQLocal/OPFS)
│   ├── migrate.test.ts
│   ├── job.test.ts
│   └── ...
├── shared/                  # 共通テストロジック
│   └── migrate.shared.ts
└── helpers/
    ├── node-dialect.ts      # libSQL 用 dialect ファクトリ
    └── browser-dialect.ts   # SQLocal 用 dialect ファクトリ
```

### Vitest 設定

```ts
// packages/durably/vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.ts'],
  },
})
```

```ts
// packages/durably/vitest.browser.config.ts
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    include: ['tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
  plugins: [
    // COOP/COEP ヘッダー設定 (OPFS に必要)
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],
})
```

### テストヘルパー

```ts
// packages/durably/tests/helpers/node-dialect.ts
import { LibsqlDialect } from '@libsql/kysely-libsql'

export function createNodeDialect() {
  return new LibsqlDialect({
    url: ':memory:',
  })
}
```

```ts
// packages/durably/tests/helpers/browser-dialect.ts
import { SQLocalKysely } from 'sqlocal/kysely'

let counter = 0

export function createBrowserDialect() {
  // 各テストで一意の DB 名を使用
  const dbName = `test-${Date.now()}-${counter++}.sqlite3`
  const { dialect } = new SQLocalKysely(dbName)
  return dialect
}
```

### テストの書き方（両環境で同じロジック）

テストロジックは共通化し、dialect だけを差し替える：

```ts
// packages/durably/tests/shared/migrate.shared.ts
import { describe, it, expect } from 'vitest'
import { createDurably } from '../../src'
import type { Dialect } from 'kysely'

export function createMigrateTests(createDialect: () => Dialect) {
  describe('migrate()', () => {
    it('creates tables', async () => {
      const dialect = createDialect()
      const durably = createDurably({ dialect })

      await durably.migrate()

      // テーブルが存在することを確認
      // ...
    })

    it('is idempotent', async () => {
      const dialect = createDialect()
      const durably = createDurably({ dialect })

      await durably.migrate()
      await durably.migrate() // 2回目も安全

      // エラーが発生しないことを確認
    })
  })
}
```

```ts
// packages/durably/tests/node/migrate.test.ts
import { createMigrateTests } from '../shared/migrate.shared'
import { createNodeDialect } from '../helpers/node-dialect'

createMigrateTests(createNodeDialect)
```

```ts
// packages/durably/tests/browser/migrate.test.ts
import { createMigrateTests } from '../shared/migrate.shared'
import { createBrowserDialect } from '../helpers/browser-dialect'

createMigrateTests(createBrowserDialect)
```

---

## Phase 0: Monorepo とテスト基盤の構築

実装に入る前に、monorepo 構成とテスト環境を整える。

### 0.1 Monorepo 構成の作成

- [ ] `pnpm-workspace.yaml` を作成
- [ ] `packages/durably/` ディレクトリを作成し、既存の src/ を移動
- [ ] ルート `package.json` を更新（private: true, workspaces scripts）
- [ ] `packages/durably/package.json` を作成

### 0.2 依存パッケージのインストール

- [ ] `pnpm --filter @coji/durably add zod`
- [ ] `pnpm --filter @coji/durably add -D vitest @vitest/browser-playwright playwright`
- [ ] `pnpm --filter @coji/durably add -D @libsql/client @libsql/kysely-libsql sqlocal`
- [ ] `pnpm --filter @coji/durably add -D kysely tsup`

### 0.3 設定ファイルの作成

- [ ] `packages/durably/vitest.config.ts` (Node.js 用)
- [ ] `packages/durably/vitest.browser.config.ts` (ブラウザ用)
- [ ] `packages/durably/tsconfig.json`
- [ ] `packages/durably/tsup.config.ts`

### 0.4 テストヘルパーの作成

- [ ] `packages/durably/tests/helpers/node-dialect.ts`
- [ ] `packages/durably/tests/helpers/browser-dialect.ts`
- [ ] 最小のテストを書いて両環境で動作確認

### 0.5 Examples の雛形作成

- [ ] `examples/node/package.json` (durably: "workspace:*")
- [ ] `examples/browser/package.json` (durably: "workspace:*")
- [ ] `pnpm install` で workspace リンクを確認

---

## Phase 1: 基盤レイヤー

### 1.1 スキーマ定義と migrate()

**テスト項目**
- [ ] `migrate()` がテーブルを作成する（runs, steps, logs, schema_versions）
- [ ] `migrate()` は冪等である（複数回呼んでも安全）
- [ ] schema_versions にバージョンが記録される

**実装ファイル**
- `src/schema.ts` - テーブル定義と型
- `src/migrations.ts` - マイグレーションロジック

### 1.2 Storage 層の抽象化

v2（AI Agent/ストリーミング対応）への拡張を見据え、データベース操作を Storage インターフェースとして抽象化する。

**テスト項目**
- [ ] Storage インターフェースが定義されている
- [ ] KyselyStorage が Storage を実装している
- [ ] createDurably が内部で Storage を使用する

**実装ファイル**
- `src/storage.ts` - Storage インターフェースと KyselyStorage 実装

```ts
// src/storage.ts
interface Storage {
  // Run 操作
  createRun(run: Run): Promise<void>
  updateRun(runId: string, data: Partial<Run>): Promise<void>
  getRun(runId: string): Promise<Run | null>
  getRuns(filter?: RunFilter): Promise<Run[]>
  getNextPendingRun(excludeConcurrencyKeys: string[]): Promise<Run | null>

  // Step 操作
  createStep(step: Step): Promise<void>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>

  // Log 操作（withLogPersistence プラグイン用）
  createLog?(log: Log): Promise<void>
  getLogs?(runId: string): Promise<Log[]>
}

// Kysely を使った実装
class KyselyStorage implements Storage {
  constructor(private db: Kysely<Database>) {}
  // ...
}
```

### 1.3 イベントシステムの基盤

イベントは Discriminated Union として定義し、`sequence` フィールドで順序を保証する。

**テスト項目**
- [ ] EventEmitter がイベントを発火できる
- [ ] イベントに sequence が自動付与される
- [ ] 複数のリスナーが登録できる
- [ ] リスナー内の例外が他に影響しない

**実装ファイル**
- `src/events.ts` - EventEmitter 実装
- `src/types.ts` - イベント型定義（DurablyEvent Union）

```ts
// src/types.ts
interface BaseEvent {
  type: string
  timestamp: string
  sequence: number
}

type DurablyEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
```

### 1.4 Durably インスタンスの作成

**テスト項目**
- [ ] `createDurably({ dialect })` がインスタンスを返す
- [ ] デフォルト設定値が正しく適用される
- [ ] カスタム設定値が反映される

**実装ファイル**
- `src/durably.ts` - メインのファクトリ関数

---

## Phase 2: ジョブ定義とトリガー

### 2.1 defineJob()

**テスト項目**
- [ ] `defineJob()` が JobHandle を返す
- [ ] ジョブ名が重複すると例外を投げる
- [ ] input スキーマで型検証される
- [ ] output スキーマで型検証される

**実装ファイル**
- `src/job.ts` - ジョブ定義ロジック
- `src/types.ts` - 型定義

### 2.2 trigger()

**テスト項目**
- [ ] `trigger()` が Run を作成して pending 状態で保存する
- [ ] `trigger()` が Run オブジェクトを返す（id, status）
- [ ] 入力が Zod スキーマに合致しないと例外を投げる
- [ ] `idempotencyKey` が同じ場合は既存の Run を返す
- [ ] `concurrencyKey` は Run 作成を妨げない（実行時に制御）

**実装ファイル**
- `src/run.ts` - Run の作成・取得ロジック

### 2.3 batchTrigger()

**テスト項目**
- [ ] 複数の Run を一括で作成できる
- [ ] トランザクション内で実行される（部分失敗しない）

---

## Phase 3: ワーカーとステップ実行

### 3.1 基本的なワーカー

**テスト項目**
- [ ] `start()` でポーリングが開始される
- [ ] `stop()` で現在の Run 完了後に停止する
- [ ] pending の Run を取得して running に遷移する
- [ ] 正常完了で completed に遷移する

**実装ファイル**
- `src/worker.ts` - ワーカーロジック

### 3.2 context.run() によるステップ実行

**テスト項目**
- [ ] `context.run()` が関数を実行して結果を返す
- [ ] ステップ成功時に steps テーブルに記録される
- [ ] ステップ失敗時に Run が failed になる
- [ ] 成功したステップは再実行時にスキップされる
- [ ] スキップ時は保存済みの output が返される
- [ ] `context.run()` の戻り値の型が推論される

**実装ファイル**
- `src/context.ts` - JobContext 実装

### 3.3 concurrencyKey による直列化

**テスト項目**
- [ ] 同じ concurrencyKey の Run が running なら取得対象外
- [ ] 別の concurrencyKey なら並行して取得可能

---

## Phase 4: 障害回復

### 4.1 Heartbeat

**テスト項目**
- [ ] 実行中の Run の heartbeat_at が定期更新される
- [ ] heartbeat 間隔は設定で変更可能

**実装ファイル**
- `src/heartbeat.ts` - Heartbeat ロジック

### 4.2 Stale Run の回収

**テスト項目**
- [ ] staleThreshold を超えた running Run は pending に戻る
- [ ] 回収された Run は再実行される
- [ ] 成功済みステップはスキップされる

### 4.3 retry()

**テスト項目**
- [ ] `retry()` が failed Run を pending に戻す
- [ ] completed Run には retry() できない
- [ ] pending/running Run には retry() できない

---

## Phase 5: Run の取得と進捗

### 5.1 getRun() / getRuns()

**テスト項目**
- [ ] `jobHandle.getRun(id)` が型安全な Run を返す
- [ ] `durably.getRun(id)` が unknown 型の Run を返す
- [ ] `getRuns({ status })` でフィルタできる
- [ ] `getRuns({ jobName })` でフィルタできる
- [ ] 結果は created_at 降順でソートされる

### 5.2 context.setProgress()

**テスト項目**
- [ ] `setProgress({ current })` で進捗が保存される
- [ ] `setProgress({ current, total, message })` で全項目保存
- [ ] `getRun()` で progress が取得できる
- [ ] 再開後も progress は保持される

---

## Phase 6: イベントシステム

### 6.1 基本イベント

**テスト項目**
- [ ] `run:start` が running 遷移時に発火する
- [ ] `run:complete` が completed 遷移時に発火する
- [ ] `run:fail` が failed 遷移時に発火する
- [ ] `step:start` がステップ開始時に発火する
- [ ] `step:complete` がステップ成功時に発火する
- [ ] `step:fail` がステップ失敗時に発火する

**実装ファイル**
- `src/events.ts` - イベントエミッター

### 6.2 型安全なイベント

**テスト項目**
- [ ] `durably.on<T>()` で型パラメータを指定できる
- [ ] jobName による Discriminated Union が機能する

---

## Phase 7: ログシステム

### 7.1 context.log

**テスト項目**
- [ ] `context.log.info()` で log:write イベントが発火する
- [ ] `context.log.warn()` で level が warn になる
- [ ] `context.log.error()` で level が error になる
- [ ] 構造化データを付与できる

### 7.2 withLogPersistence プラグイン

**テスト項目**
- [ ] プラグイン有効時、logs テーブルに記録される
- [ ] プラグイン無効時、logs テーブルは空のまま

**実装ファイル**
- `src/plugins/log-persistence.ts`

---

## Phase 8: プラグインシステム

### 8.1 use()

**テスト項目**
- [ ] `durably.use(plugin)` でプラグインが登録される
- [ ] プラグインはイベントを購読できる
- [ ] 複数のプラグインを登録できる

---

## Examples

各フェーズの完了時に、対応する example を更新・追加していく。

### Node.js Example (`examples/node/`)

```json
// examples/node/package.json
{
  "name": "example-node",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx basic.ts"
  },
  "dependencies": {
    "@coji/durably": "workspace:*",
    "@libsql/client": "^0.14.0",
    "@libsql/kysely-libsql": "^0.7.0",
    "kysely": "^0.27.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0"
  }
}
```

```ts
// examples/node/basic.ts
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'
import { createDurably } from '@coji/durably'

// Turso の場合は環境変数から URL と authToken を取得
// ローカル開発では libsql://localhost:8080 または file:local.db を使用
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const durably = createDurably({ dialect })

// ジョブ定義
const syncUsers = durably.defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ count: z.number() }),
}, async (context, payload) => {
  context.log.info('starting sync', { orgId: payload.orgId })

  const users = await context.run('fetch-users', async () => {
    // 外部 API からユーザー取得（シミュレート）
    await new Promise(r => setTimeout(r, 1000))
    return [{ id: '1', name: 'Alice' }, { id: '2', name: 'Bob' }]
  })

  await context.run('save-users', async () => {
    context.log.info('saving users', { count: users.length })
    // DB に保存（シミュレート）
    await new Promise(r => setTimeout(r, 500))
  })

  return { count: users.length }
})

// イベント購読
durably.on('run:complete', (event) => {
  console.log(`Run ${event.runId} completed`)
})

// 初期化と実行
await durably.migrate()
durably.start()

// ジョブをトリガー
const run = await syncUsers.trigger({ orgId: 'org_123' })
console.log(`Triggered run: ${run.id}`)

// 少し待ってから結果を確認
await new Promise(r => setTimeout(r, 3000))
const result = await syncUsers.getRun(run.id)
console.log('Result:', result)

await durably.stop()
```

### Browser Example (`examples/browser/`)

```json
// examples/browser/package.json
{
  "name": "example-browser",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite"
  },
  "dependencies": {
    "@coji/durably": "workspace:*",
    "sqlocal": "^0.12.0",
    "kysely": "^0.27.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
```

```ts
// examples/browser/src/main.ts
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'
import { createDurably } from '@coji/durably'

const { dialect } = new SQLocalKysely('example.sqlite3')
const durably = createDurably({ dialect })

const processData = durably.defineJob({
  name: 'process-data',
  input: z.object({ items: z.array(z.string()) }),
  output: z.object({ processed: z.number() }),
}, async (context, payload) => {
  context.setProgress({ current: 0, total: payload.items.length })

  for (let i = 0; i < payload.items.length; i++) {
    await context.run(`process-${i}`, async () => {
      // 処理（シミュレート）
      await new Promise(r => setTimeout(r, 200))
    })
    context.setProgress({ current: i + 1, message: `Processed ${payload.items[i]}` })
  }

  return { processed: payload.items.length }
})

// UI に進捗を表示
durably.on('step:complete', (event) => {
  document.getElementById('status')!.textContent =
    `Step ${event.stepName} completed`
})

await durably.migrate()
durably.start()

// ボタンクリックでジョブ実行
document.getElementById('run-btn')!.addEventListener('click', async () => {
  const run = await processData.trigger({
    items: ['item1', 'item2', 'item3']
  })

  // ポーリングで進捗を表示
  const interval = setInterval(async () => {
    const current = await processData.getRun(run.id)
    if (current?.progress) {
      document.getElementById('progress')!.textContent =
        `${current.progress.current}/${current.progress.total}`
    }
    if (current?.status === 'completed' || current?.status === 'failed') {
      clearInterval(interval)
      document.getElementById('result')!.textContent =
        JSON.stringify(current, null, 2)
    }
  }, 100)
})
```

```html
<!-- examples/browser/index.html -->
<!DOCTYPE html>
<html>
<head>
  <title>Durably Browser Example</title>
</head>
<body>
  <h1>Durably Browser Example</h1>
  <button id="run-btn">Run Job</button>
  <p>Status: <span id="status">Ready</span></p>
  <p>Progress: <span id="progress">-</span></p>
  <pre id="result"></pre>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

```ts
// examples/browser/vite.config.ts
import { defineConfig } from 'vite'
import { sqlocal } from 'sqlocal/vite'

export default defineConfig({
  plugins: [sqlocal()],
})
```

### Example の更新タイミング

| Phase | Example に追加する内容 |
|-------|----------------------|
| Phase 1 | 基本構成、migrate() |
| Phase 2 | defineJob(), trigger() |
| Phase 3 | ワーカー起動、context.run() |
| Phase 5 | getRun(), setProgress() |
| Phase 6 | イベント購読 |
| Phase 7 | context.log, withLogPersistence |

---

## ファイル構成（予定）

```txt
durably/                          # リポジトリルート
├── packages/
│   └── durably/                  # コアライブラリ
│       ├── src/
│       │   ├── index.ts          # エントリーポイント、エクスポート
│       │   ├── durably.ts        # createDurably ファクトリ
│       │   ├── types.ts          # 共通型定義（DurablyEvent Union 含む）
│       │   ├── schema.ts         # DB スキーマ定義
│       │   ├── migrations.ts     # マイグレーションロジック
│       │   ├── storage.ts        # Storage インターフェースと KyselyStorage 実装
│       │   ├── job.ts            # defineJob, JobHandle
│       │   ├── run.ts            # Run の作成・取得
│       │   ├── context.ts        # JobContext（context.run, context.log, context.setProgress）
│       │   ├── worker.ts         # ワーカー（ポーリング、実行）
│       │   ├── heartbeat.ts      # Heartbeat 管理
│       │   ├── events.ts         # イベントエミッター（sequence 付与）
│       │   ├── ulid.ts           # ULID 生成ユーティリティ
│       │   └── plugins/
│       │       ├── index.ts
│       │       └── log-persistence.ts
│       ├── tests/
│       │   ├── node/             # Node.js テスト
│       │   ├── browser/          # ブラウザテスト
│       │   ├── shared/           # 共通テストロジック
│       │   └── helpers/          # dialect ファクトリなど
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsup.config.ts
│       ├── vitest.config.ts
│       └── vitest.browser.config.ts
├── examples/
│   ├── node/                     # Node.js サンプル
│   │   ├── package.json          # "@coji/durably": "workspace:*"
│   │   └── basic.ts
│   └── browser/                  # ブラウザサンプル (Vite)
│       ├── package.json          # "@coji/durably": "workspace:*"
│       ├── vite.config.ts
│       ├── index.html
│       └── src/main.ts
├── pnpm-workspace.yaml
├── package.json                  # ルート（scripts のみ）
└── tsconfig.json                 # ベース設定
```

---

## 実装の進め方

1. **Phase 0 でテスト基盤を構築**
   - 両環境でテストが実行できることを確認してから Phase 1 へ

2. **Phase 1 から順番に進める**
   - 各フェーズ内のテスト項目を1つずつ実装
   - テストが通ったら次の項目へ

3. **1つのテスト項目の流れ**
   ```
   1. tests/shared/ に共通テストロジックを追加（RED）
   2. tests/node/ と tests/browser/ から呼び出す
   3. 最小限の実装でテストを通す（GREEN）
   4. 必要に応じてリファクタリング（REFACTOR）
   5. コミット
   ```

4. **コミット粒度**
   - 1つのテスト項目 = 1コミット を基本とする
   - 関連する複数項目をまとめてもよい

5. **フェーズ完了時**
   - `pnpm test` で全テストが通ることを確認
   - README や CLAUDE.md を必要に応じて更新

---

## ブラウザテストの注意点

### OPFS の制約

- **Secure Context 必須**: HTTPS または localhost でのみ動作
- **Worker スレッド**: SQLocal は内部で Web Worker を使用
- **COOP/COEP ヘッダー**: SharedArrayBuffer に必要（Vitest 設定で対応済み）

### テスト時の考慮事項

- **DB 分離**: 各テストで一意の DB 名を使用（並列実行対策）
- **クリーンアップ**: OPFS 上の DB ファイルは明示的に削除が必要な場合がある
- **タイムアウト**: ブラウザテストは Node.js より遅いことがある

---

## v2 への準備（実装時の注意点）

v1 実装時に以下の設計指針を守ることで、v2（AI Agent/ストリーミング対応）への拡張がスムーズになる。詳細は [durably.md](./durably.md) の「内部設計指針」および [future-spec-ai-agent.md](./future-spec-ai-agent.md) を参照。

### 必須事項

| 項目 | 対応フェーズ | 備考 |
|------|-------------|------|
| イベント型を Discriminated Union で定義 | Phase 1.3 | `type` と `sequence` フィールドを含める |
| JobContext をクラス/ファクトリで実装 | Phase 3.2 | メソッド追加が容易な構造に |
| Storage 層を抽象化 | Phase 1.2 | インターフェースを定義し実装を分離 |
| EventEmitter で sequence を自動付与 | Phase 1.3 | v2 でイベント永続化時に必要 |

### 任意事項

| 項目 | 備考 |
|------|------|
| runs テーブルに `last_event_sequence` カラム | v1 では使用しないが、v2 でのマイグレーション不要に |

---

## 次のアクション

Phase 0 を開始する：

1. `pnpm-workspace.yaml` を作成
2. `packages/durably/` を作成し、既存の src/ を移動
3. 各 package.json を設定
4. 依存パッケージをインストール
5. vitest.config.ts と vitest.browser.config.ts を作成
6. テストヘルパーを作成
7. 両環境で動作する最小のテストを書いて確認
8. examples/ の雛形を作成
