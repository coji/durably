/**
 * Browser Example for Durably
 *
 * This example shows basic usage of Durably with SQLocal (SQLite WASM + OPFS).
 */

import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

const DB_NAME = 'example.sqlite3'
const sqlocal = new SQLocalKysely(DB_NAME)
const { dialect, deleteDatabaseFile } = sqlocal

const durably = createDurably({
  dialect,
  pollingInterval: 100,
})

// UI elements
const statusEl = document.getElementById('status') as HTMLElement
const progressEl = document.getElementById('progress') as HTMLElement
const resultEl = document.getElementById('result') as HTMLPreElement
const statsEl = document.getElementById('stats') as HTMLElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

// Define job
const processData = durably.defineJob(
  {
    name: 'process-data',
    input: z.object({ items: z.array(z.string()) }),
    output: z.object({ processed: z.number() }),
  },
  async (ctx, payload) => {
    ctx.progress(0, payload.items.length)

    for (let i = 0; i < payload.items.length; i++) {
      await ctx.run(`process-${i}`, async () => {
        await new Promise((r) => setTimeout(r, 500))
        return `Processed: ${payload.items[i]}`
      })
      ctx.progress(i + 1, payload.items.length, `Processed ${payload.items[i]}`)
    }

    return { processed: payload.items.length }
  },
)

// Update stats display
async function updateStats() {
  try {
    const runs = await durably.storage.getRuns()
    const pending = runs.filter((r) => r.status === 'pending').length
    const running = runs.filter((r) => r.status === 'running').length
    const completed = runs.filter((r) => r.status === 'completed').length
    const failed = runs.filter((r) => r.status === 'failed').length

    statsEl.innerHTML = `
      <strong>Database Stats:</strong><br>
      Total runs: ${runs.length}<br>
      Pending: ${pending} | Running: ${running} | Completed: ${completed} | Failed: ${failed}
    `
  } catch {
    statsEl.textContent = 'Stats unavailable'
  }
}

// Subscribe to events
durably.on('step:complete', (event) => {
  statusEl.textContent = `Step ${event.stepName} completed`
})

durably.on('run:complete', (event) => {
  statusEl.textContent = 'Completed!'
  resultEl.textContent = JSON.stringify(event.output, null, 2)
  updateStats()
})

durably.on('run:fail', (event) => {
  statusEl.textContent = `Failed: ${event.error}`
  updateStats()
})

// Initialize
async function init() {
  statusEl.textContent = 'Initializing...'

  await durably.migrate()
  durably.start()

  statusEl.textContent = 'Ready'
  runBtn.disabled = false
  refreshBtn.disabled = false
  resetBtn.disabled = false

  await updateStats()
}

// Run job
async function runJob() {
  runBtn.disabled = true
  statusEl.textContent = 'Running...'
  progressEl.textContent = '0/3'
  resultEl.textContent = ''

  const run = await processData.trigger({
    items: ['item1', 'item2', 'item3'],
  })

  await updateStats()

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

// Reset database
async function resetDatabase() {
  if (!confirm('Delete the database and all data?')) {
    return
  }

  runBtn.disabled = true
  refreshBtn.disabled = true
  resetBtn.disabled = true
  statusEl.textContent = 'Resetting...'

  try {
    await durably.stop()
    await deleteDatabaseFile()
    statusEl.textContent = 'Database deleted. Reloading...'
    setTimeout(() => location.reload(), 500)
  } catch (err) {
    statusEl.textContent = `Reset failed: ${err instanceof Error ? err.message : 'Unknown'}`
    runBtn.disabled = false
    refreshBtn.disabled = false
    resetBtn.disabled = false
  }
}

// Event listeners
runBtn.addEventListener('click', runJob)
refreshBtn.addEventListener('click', updateStats)
resetBtn.addEventListener('click', resetDatabase)

runBtn.disabled = true
refreshBtn.disabled = true
resetBtn.disabled = true

// Initialize
init().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`
  console.error(err)
})
