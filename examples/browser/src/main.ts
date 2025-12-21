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
  await processImage.trigger({ filename: 'photo.jpg' })
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
// Dashboard Tab
// ============================================

const runsTbody = document.getElementById(
  'runs-tbody',
) as HTMLTableSectionElement
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement
const runDetailsEl = document.getElementById('run-details') as HTMLDivElement
const detailsContent = document.getElementById(
  'details-content',
) as HTMLDivElement

refreshBtn.addEventListener('click', refreshDashboard)

async function refreshDashboard() {
  const runs = await durably.getRuns({ limit: 20 })

  if (runs.length === 0) {
    runsTbody.innerHTML = `<tr><td colspan="5" class="empty-state">No runs yet</td></tr>`
    runDetailsEl.style.display = 'none'
    return
  }

  runsTbody.innerHTML = runs
    .map(
      (run) => `
    <tr data-id="${run.id}">
      <td class="run-id">${run.id.slice(0, 8)}...</td>
      <td>${run.jobName}</td>
      <td><span class="status-badge status-${run.status}">${run.status}</span></td>
      <td>${formatDate(run.createdAt)}</td>
      <td>
        <button class="action-btn view-btn" data-id="${run.id}">View</button>
        ${run.status === 'failed' ? `<button class="action-btn retry-btn" data-id="${run.id}">Retry</button>` : ''}
        ${run.status === 'running' || run.status === 'pending' ? `<button class="action-btn cancel-btn" data-id="${run.id}">Cancel</button>` : ''}
        ${run.status !== 'running' && run.status !== 'pending' ? `<button class="action-btn delete-btn" data-id="${run.id}">Delete</button>` : ''}
      </td>
    </tr>
  `,
    )
    .join('')

  // Add event listeners
  runsTbody.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      showRunDetails((btn as HTMLElement).dataset.id!),
    )
  })
  runsTbody.querySelectorAll('.retry-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await durably.retry((btn as HTMLElement).dataset.id!)
      refreshDashboard()
    })
  })
  runsTbody.querySelectorAll('.cancel-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await durably.cancel((btn as HTMLElement).dataset.id!)
      refreshDashboard()
    })
  })
  runsTbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await durably.deleteRun((btn as HTMLElement).dataset.id!)
      refreshDashboard()
    })
  })
}

async function showRunDetails(runId: string) {
  const run = await durably.getRun(runId)
  if (!run) {
    runDetailsEl.style.display = 'none'
    return
  }

  const steps = await durably.storage.getSteps(runId)

  detailsContent.innerHTML = `
    <p><strong>ID:</strong> <span class="run-id">${run.id}</span></p>
    <p><strong>Job:</strong> ${run.jobName}</p>
    <p><strong>Status:</strong> <span class="status-badge status-${run.status}">${run.status}</span></p>
    <p><strong>Created:</strong> ${formatDate(run.createdAt)}</p>
    ${run.progress ? `<p><strong>Progress:</strong> ${run.progress.current}${run.progress.total ? `/${run.progress.total}` : ''} ${run.progress.message || ''}</p>` : ''}
    ${run.error ? `<p><strong>Error:</strong> <span style="color: #dc3545">${run.error}</span></p>` : ''}
    ${run.output ? `<p><strong>Output:</strong></p><pre class="result">${JSON.stringify(run.output, null, 2)}</pre>` : ''}
    <p><strong>Payload:</strong></p>
    <pre class="result">${JSON.stringify(run.payload, null, 2)}</pre>
    ${
      steps.length > 0
        ? `
      <p><strong>Steps:</strong></p>
      <ul class="steps-list">
        ${steps.map((s) => `<li><span>${s.name}</span><span class="status-badge status-${s.status === 'completed' ? 'completed' : 'failed'}">${s.status}</span></li>`).join('')}
      </ul>
    `
        : ''
    }
  `
  runDetailsEl.style.display = 'block'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

// ============================================
// Initialize
// ============================================

durably.migrate().then(() => {
  durably.start()
  setStatus('ready')
  runBtn.disabled = false
  reloadBtn.disabled = false
  resetBtn.disabled = false
  refreshDashboard()
})
