# ブラウザ

このガイドでは、ブラウザ環境でのDurablyの使用方法を説明します。

## 要件

### セキュアコンテキスト

DurablyはOPFSアクセスのために[セキュアコンテキスト](https://developer.mozilla.org/ja/docs/Web/Security/Secure_Contexts)（HTTPSまたはlocalhost）が必要です。

### COOP/COEPヘッダー

SQLite WASMはクロスオリジン分離が必要です：

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

#### Vite設定

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
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
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
})
```

## SQLiteセットアップ

OPFSを使用した[SQLocal](https://sqlocal.dev/)：

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect, deleteDatabaseFile } = new SQLocalKysely('app.sqlite3')

const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})
```

## ブラウザ固有の設定

レスポンシブなUI向けに短い間隔を設定：

```ts
const durably = createDurably({
  dialect,
  pollingInterval: 100,     // 100msごとにチェック
  heartbeatInterval: 500,   // 500msごとにハートビート
  staleThreshold: 3000,     // 3秒後に失効
})
```

## React統合

hooks、StrictMode互換性、状態管理などのReact固有のパターンについては、専用の[Reactガイド](/ja/guide/react)を参照してください。

## タブのサスペンド

ブラウザは非アクティブなタブをサスペンドすることがあります。Durablyはこれを処理します：

1. タブが非アクティブになる → ハートビートが停止
2. `staleThreshold`後にジョブが失効としてマークされる
3. タブがアクティブになる → ワーカーが再起動
4. 失効したジョブが取得され再開

### 再開のテスト

1. ジョブを開始
2. 実行中にページをリロード
3. ジョブは最後に完了したステップから再開

## データベース管理

### データベースのリセット

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect, deleteDatabaseFile } = new SQLocalKysely('app.sqlite3')

// リセットするには：
await durably.stop()
await deleteDatabaseFile()
location.reload()
```

### データベースサイズ

OPFSにはストレージ制限があります。使用量を監視：

```ts
const estimate = await navigator.storage.estimate()
console.log(`使用量: ${estimate.usage} / ${estimate.quota}`)
```

## 制限事項

1. **シングルタブ**: OPFSは排他的アクセス - 1つのタブのみがデータベースを使用可能
2. **SharedWorkerなし**: ワーカーは同じタブ内にある必要がある
3. **ストレージ制限**: ブラウザのストレージクォータが適用される
4. **バックグラウンド同期なし**: ジョブはタブがアクティブな場合のみ実行される
