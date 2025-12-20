/**
 * Browser Example for Durably
 *
 * This example shows basic usage of Durably with SQLocal (SQLite WASM + OPFS).
 */

import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'
import { createDurably } from '@coji/durably'

const { dialect } = new SQLocalKysely('example.sqlite3')

const durably = createDurably({
  dialect,
  pollingInterval: 100,
})

// UI elements
const statusEl = document.getElementById('status')!
const progressEl = document.getElementById('progress')!
const resultEl = document.getElementById('result')!
const runBtn = document.getElementById('run-btn') as HTMLButtonElement

// データ処理ジョブを定義
const processData = durably.defineJob(
  {
    name: 'process-data',
    input: z.object({ items: z.array(z.string()) }),
    output: z.object({ processed: z.number() }),
  },
  async (ctx, payload) => {
    ctx.setProgress({ current: 0, total: payload.items.length })

    for (let i = 0; i < payload.items.length; i++) {
      await ctx.run(`process-${i}`, async () => {
        // 処理をシミュレート
        await new Promise((r) => setTimeout(r, 500))
        return `Processed: ${payload.items[i]}`
      })
      ctx.setProgress({
        current: i + 1,
        total: payload.items.length,
        message: `Processed ${payload.items[i]}`,
      })
    }

    return { processed: payload.items.length }
  },
)

// イベントを購読
durably.on('step:complete', (event) => {
  statusEl.textContent = `Step ${event.stepName} completed`
})

durably.on('run:complete', (event) => {
  statusEl.textContent = 'Completed!'
  resultEl.textContent = JSON.stringify(event.output, null, 2)
})

durably.on('run:fail', (event) => {
  statusEl.textContent = `Failed: ${event.error}`
})

// 初期化
async function init() {
  statusEl.textContent = 'Initializing...'

  await durably.migrate()
  durably.start()

  statusEl.textContent = 'Ready'
  runBtn.disabled = false
}

// ジョブ実行
async function runJob() {
  runBtn.disabled = true
  statusEl.textContent = 'Running...'
  progressEl.textContent = '0/3'
  resultEl.textContent = ''

  const run = await processData.trigger({
    items: ['item1', 'item2', 'item3'],
  })

  // 進捗を監視
  const interval = setInterval(async () => {
    const current = await processData.getRun(run.id)

    if (current?.progress) {
      progressEl.textContent = `${current.progress.current}/${current.progress.total}`
      if (current.progress.message) {
        statusEl.textContent = current.progress.message
      }
    }

    if (current?.status === 'completed' || current?.status === 'failed') {
      clearInterval(interval)
      runBtn.disabled = false
    }
  }, 100)
}

// イベントリスナー
runBtn.addEventListener('click', runJob)
runBtn.disabled = true

// 初期化実行
init().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`
  console.error(err)
})
