/**
 * Dashboard Module for Durably Browser Example
 *
 * Displays run history with status, details, and action buttons.
 */

import type { Durably } from '@coji/durably'

let durably: Durably

const runsTbody = document.getElementById(
  'runs-tbody',
) as HTMLTableSectionElement
const refreshBtn = document.getElementById('refresh-btn') as HTMLButtonElement
const runDetailsEl = document.getElementById('run-details') as HTMLDivElement
const detailsContent = document.getElementById(
  'details-content',
) as HTMLDivElement

export function initDashboard(durablyInstance: Durably) {
  durably = durablyInstance
  refreshBtn.addEventListener('click', refreshDashboard)
}

export async function refreshDashboard() {
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
