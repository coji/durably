# デプロイ

Durablyはジョブをポーリングして実行するための長時間実行プロセスが必要です。このガイドではデプロイオプションと制限事項を説明します。

## 要件

Durablyワーカーに必要なもの：

- **永続プロセス**: ジョブをポーリングするために継続的に実行されるプロセス
- **SQLiteアクセス**: ローカルファイル、Turso cloud、またはブラウザOPFS
- **リクエストタイムアウトなし**: ジョブは数分から数時間かかることがある

## 推奨プラットフォーム

### Fly.io

長時間実行プロセスとしてデプロイ：

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "worker.js"]
```

```toml
# fly.toml
[processes]
  worker = "node worker.js"
```

### Railway

標準的なNode.jsデプロイでそのまま動作します。別のワーカーサービスをセットアップするか、Webサーバーと一緒に実行します。

### Docker / VPS

長時間実行Node.jsプロセスをサポートする任意の環境：

```bash
# PM2
pm2 start worker.js --name durably-worker

# systemd
[Service]
ExecStart=/usr/bin/node /app/worker.js
Restart=always
```

### Render

「Web Service」ではなく「Background Worker」サービスタイプを使用してください。

## 非推奨

### サーバーレス関数

Durablyはサーバーレス環境と**互換性がありません**：

| プラットフォーム | 制限 |
|----------|------------|
| Vercel Functions | 10秒〜300秒のタイムアウト |
| Cloudflare Workers | 30秒のCPU時間制限 |
| AWS Lambda | 最大15分のタイムアウト |
| Netlify Functions | 10秒〜26秒のタイムアウト |

**動作しない理由：**

1. **ポーリングモデル**: Durablyは保留中のジョブを継続的にポーリング
2. **長時間実行ジョブ**: ステップが完了するまで数分かかることがある
3. **コールドスタート**: 各呼び出しは新規に開始され、継続性が失われる
4. **コスト**: 従量課金モデルでは常時ポーリングは高額になる

### 回避策（上級者向け）

ジョブのトリガーにサーバーレスを使用する必要がある場合：

1. **トリガーのみ**: サーバーレスで`job.trigger()`を呼び出し、ジョブをTursoに保存
2. **別のワーカー**: 実際のワーカーは長時間実行プラットフォームで実行

```ts
// Vercel APIルート - トリガーのみ
export async function POST(req: Request) {
  const payload = await req.json()
  await myJob.trigger(payload) // DBに挿入するだけ
  return Response.json({ status: 'queued' })
}

// Fly.io ワーカー - ジョブを処理
durably.start() // 長時間実行ポーリング
```

## ブラウザデプロイ

ブラウザベースのワーカー（OPFS付きSQLite WASMを使用）の場合：

- 静的サイトをどこでもホスト可能（Vercel、Netlify、GitHub Pages）
- ワーカーはユーザーのブラウザで完全に実行
- データはOPFS（Origin Private File System）に永続化
- HTTPS（セキュアコンテキスト）が必要

詳細は[ブラウザガイド](/ja/guide/browser)を参照してください。

## データベースの考慮事項

### Turso（本番環境に推奨）

- ホストされたSQLite互換データベース
- 任意のプラットフォームから動作（トリガー用のサーバーレスを含む）
- 組み込みのレプリケーションとバックアップ

### ローカルSQLite

- シングルサーバーデプロイに適している
- コンテナ化されたプラットフォームでは永続ボリュームを使用
- 水平スケーリングには不向き

## ヘルスチェック

イベントでワーカーを監視：

```ts
durably.on('run:complete', (event) => {
  metrics.increment('jobs.completed')
})

durably.on('run:fail', (event) => {
  metrics.increment('jobs.failed')
  alerting.notify(event.error)
})
```

## グレースフルシャットダウン

常にシャットダウンシグナルを処理：

```ts
process.on('SIGTERM', async () => {
  console.log('シャットダウン中...')
  await durably.stop()
  process.exit(0)
})
```

これにより、進行中のジョブが停止する前に現在のステップを完了できます。
