/**
 * Browser Example for Durably
 *
 * Simple example showing basic durably usage in the browser.
 * Demonstrates job resumption after page reload.
 */

import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'
import { initDashboard, refreshDashboard } from './dashboard'

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
const processImage = durably.register(
  defineJob({
    name: 'process-image',
    input: z.object({ filename: z.string(), width: z.number() }),
    output: z.object({ url: z.string(), size: z.number() }),
    run: async (step, payload) => {
      // Download original image
      const fileSize = await step.run('download', async () => {
        await delay(300)
        return Math.floor(Math.random() * 1000000) + 500000 // 500KB-1.5MB
      })

      // Resize to target width
      const resizedSize = await step.run('resize', async () => {
        await delay(400)
        return Math.floor(fileSize * (payload.width / 1920))
      })

      // Upload to CDN
      const url = await step.run('upload', async () => {
        await delay(300)
        return `https://cdn.example.com/${payload.width}/${payload.filename}`
      })

      return { url, size: resizedSize }
    },
  }),
)

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============================================
// Demo Tab
// ============================================

const statusEl = document.getElementById('status') as HTMLElement
const stepEl = document.getElementById('step') as HTMLElement
const resultEl = document.getElementById('result') as HTMLPreElement
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const reloadBtn = document.getElementById('reload-btn') as HTMLButtonElement
const resetBtn = document.getElementById('reset-btn') as HTMLButtonElement

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
  refreshDashboard()
})

durably.on('run:fail', (e) => {
  setResult(e.error, true)
  setStep(null)
  setStatus('error')
  setProcessing(false)
  userTriggered = false
  refreshDashboard()
})

// Button handlers
runBtn.addEventListener('click', async () => {
  userTriggered = true
  setStatus('running')
  setStep(null)
  setResult(null)
  await processImage.trigger({ filename: 'photo.jpg', width: 800 })
  refreshDashboard()
})

reloadBtn.addEventListener('click', () => {
  location.reload()
})

resetBtn.addEventListener('click', async () => {
  await durably.stop()
  await deleteDatabaseFile()
  location.reload()
})

// ============================================
// Tab Navigation
// ============================================

const tabs = Array.from(document.querySelectorAll('.tab'))
const tabContents = Array.from(document.querySelectorAll('.tab-content'))

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    const tabName = (tab as HTMLElement).dataset.tab
    for (const t of tabs) t.classList.remove('active')
    for (const c of tabContents) c.classList.remove('active')
    tab.classList.add('active')
    document.getElementById(`${tabName}-tab`)?.classList.add('active')

    if (tabName === 'dashboard') {
      refreshDashboard()
    }
  })
}

// ============================================
// Initialize
// ============================================

initDashboard(durably)

durably.migrate().then(() => {
  durably.start()
  setStatus('ready')
  runBtn.disabled = false
  reloadBtn.disabled = false
  resetBtn.disabled = false
  refreshDashboard()
})
