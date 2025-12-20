/**
 * Node.js Example for Durably
 *
 * This example shows basic usage of Durably with Turso/libSQL.
 */

import { createDurably } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

// Turso の場合は環境変数から URL と authToken を取得
// ローカル開発では file:local.db を使用
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const durably = createDurably({ dialect })

// ユーザー同期ジョブを定義
const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
    output: z.object({ count: z.number() }),
  },
  async (ctx, payload) => {
    ctx.log.info('starting sync', { orgId: payload.orgId })

    // Step 1: ユーザーを取得
    const users = await ctx.run('fetch-users', async () => {
      console.log('Fetching users...')
      await new Promise((r) => setTimeout(r, 1000))
      return [
        { id: '1', name: 'Alice' },
        { id: '2', name: 'Bob' },
      ]
    })

    // Step 2: ユーザーを保存
    await ctx.run('save-users', async () => {
      ctx.log.info('saving users', { count: users.length })
      console.log(`Saving ${users.length} users...`)
      await new Promise((r) => setTimeout(r, 500))
    })

    return { count: users.length }
  },
)

// イベントを購読
durably.on('run:start', (event) => {
  console.log(`Run ${event.runId} started`)
})

durably.on('run:complete', (event) => {
  console.log(`Run ${event.runId} completed with output:`, event.output)
})

durably.on('step:complete', (event) => {
  console.log(`Step ${event.stepName} completed`)
})

// メイン処理
async function main() {
  console.log('Durably Node.js Example')
  console.log('========================')

  // マイグレーション実行
  await durably.migrate()
  console.log('Migration completed')

  // ワーカー開始
  durably.start()
  console.log('Worker started')

  // ジョブをトリガー
  const run = await syncUsers.trigger({ orgId: 'org_123' })
  console.log(`Triggered run: ${run.id}`)

  // 完了を待つ
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(async () => {
      const current = await syncUsers.getRun(run.id)
      if (current?.status === 'completed' || current?.status === 'failed') {
        clearInterval(checkInterval)
        console.log('\nFinal result:', JSON.stringify(current, null, 2))
        resolve()
      }
    }, 100)
  })

  // クリーンアップ
  await durably.stop()
  await durably.db.destroy()
  console.log('\nDone!')
}

main().catch(console.error)
