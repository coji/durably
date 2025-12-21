/**
 * Browser Example for Durably
 *
 * Simple example showing basic durably usage in the browser.
 * Demonstrates job resumption after page reload.
 */

import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Initialize Durably
const sqlocal = new SQLocalKysely('example.sqlite3')
const { dialect, deleteDatabaseFile } = sqlocal

const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})

// Define job
const processImage = durably.defineJob(
  {
    name: 'process-image',
    input: z.object({ filename: z.string() }),
    output: z.object({ url: z.string() }),
  },
  async (ctx, payload) => {
    await ctx.run('download', () => delay(500))
    await ctx.run('resize', () => delay(500))
    await ctx.run('upload', () => delay(500))
    return { url: `https://cdn.example.com/${payload.filename}` }
  },
)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// UI elements
const statusEl = document.getElementById('status') as HTMLElement
const stepEl = document.getElementById('step') as HTMLElement
const resultEl = document.getElementById('result') as HTMLPreElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

// State
let userTriggered = false

const statusText: Record<string, string> = {
  init: 'Initializing...',
  ready: 'Ready',
  running: 'Running',
  resuming: '🔄 Resuming interrupted job...',
  done: '✓ Completed',
  error: '✗ Failed',
}

function setStatus(status: string) {
  statusEl.textContent = statusText[status] || status
}

function setStep(step: string | null) {
  stepEl.textContent = step ? `Step: ${step}` : ''
}

function setResult(result: string | null, isError = false) {
  resultEl.textContent = result || ''
  resultEl.className = isError ? 'result error' : 'result'
}

function setProcessing(processing: boolean) {
  runBtn.disabled = processing
  resetBtn.disabled = processing
}

// Subscribe to events
durably.on('run:start', () => {
  setStatus(userTriggered ? 'running' : 'resuming')
  setProcessing(true)
})

durably.on('step:complete', (e) => {
  setStep(e.stepName)
})

durably.on('run:complete', (e) => {
  setResult(JSON.stringify(e.output, null, 2))
  setStep(null)
  setStatus('done')
  setProcessing(false)
  userTriggered = false
})

durably.on('run:fail', (e) => {
  setResult(e.error, true)
  setStep(null)
  setStatus('error')
  setProcessing(false)
  userTriggered = false
})

// Button handlers
runBtn.addEventListener('click', async () => {
  userTriggered = true
  setStatus('running')
  setStep(null)
  setResult(null)
  await processImage.trigger({ filename: 'photo.jpg' })
})

reloadBtn.addEventListener('click', () => {
  location.reload()
})

resetBtn.addEventListener('click', async () => {
  await durably.stop()
  await deleteDatabaseFile()
  location.reload()
})

// Initialize
durably.migrate().then(() => {
  durably.start()
  setStatus('ready')
  runBtn.disabled = false
  reloadBtn.disabled = false
  resetBtn.disabled = false
})
