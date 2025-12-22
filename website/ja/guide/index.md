# Durablyとは？

Durablyは、Node.jsとブラウザの両方で**再開可能なワークフロー**を実現するステップ指向のバッチ実行フレームワークです。

## 課題

バッチジョブやワークフローを実行する際、様々なタイミングで障害が発生する可能性があります：
- API呼び出し中のネットワークエラー
- プロセスのクラッシュ
- ブラウザタブの終了
- サーバーの再起動

従来のアプローチでは、以下のいずれかが必要でした：
- ジョブ全体を最初から再実行する
- 複雑なチェックポイントロジックを手動で実装する

## 解決策

Durablyは各ステップの結果をSQLiteに自動的に永続化します。ジョブが中断された場合、最後に成功したステップから再開します。

```ts
const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
  },
  async (step, payload) => {
    // ステップ1: ユーザーを取得（完了後に永続化）
    const users = await step.run('fetch-users', async () => {
      return api.fetchUsers(payload.orgId)
    })

    // ステップ2: データベースに保存（既に完了していればスキップ）
    await step.run('save-to-db', async () => {
      await db.upsertUsers(users)
    })

    return { syncedCount: users.length }
  },
)
```

## 主な機能

- **ステップレベルの永続化**: 各`step.run()`呼び出しがチェックポイントを作成
- **自動再開**: 中断されたジョブは最後に成功したステップから再開
- **クロスプラットフォーム**: 同じコードがNode.jsとブラウザで動作
- **最小限の依存関係**: KyselyとZodのみ
- **型安全**: スキーマ検証を備えた完全なTypeScriptサポート

## Durablyの用途

Durablyは以下の用途に最適です：

- **データ同期ジョブ** - 外部APIからのデータ取得と処理
- **バッチ処理** - 大規模データセットのステップごとの処理
- **ブラウザワークフロー** - ページリロード後も継続する長時間実行操作
- **オフラインファーストアプリケーション** - 接続復旧後に再開が必要な操作

## 次のステップ

- [はじめる](/ja/guide/getting-started) - インストールと最初のジョブの作成
- [ジョブとステップ](/ja/guide/jobs-and-steps) - コアコンセプトを学ぶ
- [ライブデモ](https://durably-demo.vercel.app) - ブラウザで試す
