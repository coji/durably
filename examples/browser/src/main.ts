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
  heartbeatInterval: 500,
  staleThreshold: 3000, // 3 seconds for demo
})

// UI elements
const statusEl = document.getElementById('status') as HTMLElement
const statusIndicatorEl = document.getElementById(
  'status-indicator',
) as HTMLElement
const progressEl = document.getElementById('progress') as HTMLElement
const progressFillEl = document.getElementById('progress-fill') as HTMLElement
const resultEl = document.getElementById('result') as HTMLPreElement
const statPendingEl = document.getElementById('stat-pending') as HTMLElement
const statRunningEl = document.getElementById('stat-running') as HTMLElement
const statCompletedEl = document.getElementById('stat-completed') as HTMLElement
const statFailedEl = document.getElementById('stat-failed') as HTMLElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

// Image processing job with sequential steps
const processImage = durably.defineJob(
  {
    name: 'process-image',
    input: z.object({ filename: z.string() }),
    output: z.object({ url: z.string() }),
  },
  async (ctx, payload) => {
    // Step 1: Download
    const data = await ctx.run('download', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { size: 1024000 }
    })

    // Step 2: Resize
    await ctx.run('resize', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { width: 800, height: 600, size: data.size / 2 }
    })

    // Step 3: Upload
    const uploaded = await ctx.run('upload', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { url: `https://cdn.example.com/${payload.filename}` }
    })

    return { url: uploaded.url }
  },
)

// Update status indicator
function setStatusIndicator(
  state: 'default' | 'ready' | 'running' | 'completed' | 'failed',
) {
  statusIndicatorEl.className = 'status-indicator'
  if (state !== 'default') {
    statusIndicatorEl.classList.add(state)
  }
}

// Update progress bar
function setProgress(current: number, total: number) {
  const percentage = total > 0 ? (current / total) * 100 : 0
  progressFillEl.style.width = `${percentage}%`
  progressEl.textContent = total > 0 ? `${current} / ${total}` : '-'
}

// Update stats display
async function updateStats() {
  try {
    const runs = await durably.storage.getRuns()
    const pending = runs.filter((r) => r.status === 'pending').length
    const running = runs.filter((r) => r.status === 'running').length
    const completed = runs.filter((r) => r.status === 'completed').length
    const failed = runs.filter((r) => r.status === 'failed').length

    statPendingEl.textContent = String(pending)
    statRunningEl.textContent = String(running)
    statCompletedEl.textContent = String(completed)
    statFailedEl.textContent = String(failed)
  } catch {
    statPendingEl.textContent = '-'
    statRunningEl.textContent = '-'
    statCompletedEl.textContent = '-'
    statFailedEl.textContent = '-'
  }
}

// Subscribe to events for real-time updates
durably.on('run:start', (event) => {
  statusEl.textContent = `Running: ${event.jobName}`
  setStatusIndicator('running')
  updateStats()
})

durably.on('step:complete', (event) => {
  statusEl.textContent = `Step: ${event.stepName} completed`
})

durably.on('run:complete', (event) => {
  statusEl.textContent = 'Completed!'
  setStatusIndicator('completed')
  resultEl.textContent = JSON.stringify(event.output, null, 2)
  runBtn.disabled = false
  updateStats()
})

durably.on('run:fail', (event) => {
  statusEl.textContent = `Failed: ${event.error}`
  setStatusIndicator('failed')
  runBtn.disabled = false
  updateStats()
})

// Initialize
async function init() {
  statusEl.textContent = 'Initializing...'

  await durably.migrate()
  durably.start()

  statusEl.textContent = 'Ready'
  setStatusIndicator('ready')
  runBtn.disabled = false
  refreshBtn.disabled = false
  resetBtn.disabled = false

  await updateStats()

  // Set up periodic stats refresh to catch stale run recovery
  setInterval(updateStats, 1000)
}

// Run job
async function runJob() {
  runBtn.disabled = true
  statusEl.textContent = 'Queued...'
  setStatusIndicator('default')
  setProgress(0, 3)
  resultEl.textContent = ''

  const run = await processImage.trigger({
    filename: 'photo.jpg',
  })

  await updateStats()

  // Track step progress via polling
  let stepCount = 0
  const interval = setInterval(async () => {
    const current = await processImage.getRun(run.id)

    if (current?.status === 'running') {
      const steps = await durably.storage.getSteps(run.id)
      const completedSteps = steps.filter((s) => s.status === 'completed').length
      if (completedSteps > stepCount) {
        stepCount = completedSteps
        setProgress(stepCount, 3)
      }
    }

    if (current?.status === 'completed' || current?.status === 'failed') {
      setProgress(3, 3)
      clearInterval(interval)
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
  setStatusIndicator('default')

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
  setStatusIndicator('failed')
  console.error(err)
})
