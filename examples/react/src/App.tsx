/**
 * React Example for Durably
 *
 * Simple example showing basic durably usage with React.
 * Demonstrates job resumption after page reload.
 */

import { createDurably, type Run } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
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

// Hook for durably lifecycle
function useDurably() {
  const [status, setStatus] = useState<
    'init' | 'ready' | 'running' | 'resuming' | 'done' | 'error'
  >('init')
  const [step, setStep] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const userTriggered = useRef(false)
  const refreshDashboardRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const unsubscribes = [
      durably.on('run:start', () =>
        setStatus(userTriggered.current ? 'running' : 'resuming'),
      ),
      durably.on('step:complete', (e) => setStep(e.stepName)),
      durably.on('run:complete', (e) => {
        setResult(JSON.stringify(e.output, null, 2))
        setStep(null)
        setStatus('done')
        userTriggered.current = false
        refreshDashboardRef.current?.()
      }),
      durably.on('run:fail', (e) => {
        setResult(e.error)
        setStep(null)
        setStatus('error')
        userTriggered.current = false
        refreshDashboardRef.current?.()
      }),
    ]

    durably.migrate().then(() => {
      durably.start()
      setStatus('ready')
    })

    return () => {
      for (const fn of unsubscribes) fn()
      durably.stop()
    }
  }, [])

  const run = async () => {
    userTriggered.current = true
    setStatus('running')
    setStep(null)
    setResult(null)
    await processImage.trigger({ filename: 'photo.jpg' })
    refreshDashboardRef.current?.()
  }

  const setRefreshDashboard = (fn: () => void) => {
    refreshDashboardRef.current = fn
  }

  return { status, step, result, run, setRefreshDashboard }
}

// Styles
const styles = {
  container: {
    padding: '2rem',
    fontFamily: 'system-ui',
    maxWidth: '800px',
    margin: '0 auto',
  },
  tabs: {
    display: 'flex',
    gap: 0,
    marginBottom: '1.5rem',
    borderBottom: '2px solid #e0e0e0',
  },
  tab: (active: boolean) => ({
    padding: '0.75rem 1.5rem',
    background: 'none',
    border: 'none',
    fontSize: '1rem',
    cursor: 'pointer',
    borderBottom: active ? '2px solid #007bff' : '2px solid transparent',
    marginBottom: '-2px',
    color: active ? '#007bff' : '#666',
    fontWeight: active ? 500 : 400,
  }),
  buttons: { display: 'flex', gap: '1rem', marginBottom: '2rem' },
  result: (isError: boolean) => ({
    background: isError ? '#fee' : '#f5f5f5',
    padding: '1rem',
    borderRadius: '4px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap' as const,
  }),
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.875rem',
  },
  th: {
    padding: '0.5rem',
    textAlign: 'left' as const,
    borderBottom: '1px solid #e0e0e0',
    background: '#f5f5f5',
  },
  td: {
    padding: '0.5rem',
    textAlign: 'left' as const,
    borderBottom: '1px solid #e0e0e0',
  },
  badge: (status: string) => ({
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
    background:
      status === 'pending'
        ? '#fff3cd'
        : status === 'running'
          ? '#cce5ff'
          : status === 'completed'
            ? '#d4edda'
            : status === 'failed'
              ? '#f8d7da'
              : '#e2e3e5',
    color:
      status === 'pending'
        ? '#856404'
        : status === 'running'
          ? '#004085'
          : status === 'completed'
            ? '#155724'
            : status === 'failed'
              ? '#721c24'
              : '#383d41',
  }),
  runId: { fontFamily: 'monospace', fontSize: '0.75rem', color: '#666' },
  actionBtn: {
    padding: '0.25rem 0.5rem',
    fontSize: '0.75rem',
    marginLeft: '0.25rem',
    cursor: 'pointer',
  },
  details: {
    marginTop: '1.5rem',
    padding: '1rem',
    background: '#f9f9f9',
    borderRadius: '4px',
  },
  stepsList: { listStyle: 'none', padding: 0, margin: 0 },
  stepsItem: {
    padding: '0.5rem',
    borderBottom: '1px solid #e0e0e0',
    display: 'flex',
    justifyContent: 'space-between',
  },
}

// Dashboard Component
function Dashboard({ onMount }: { onMount: (refresh: () => void) => void }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState<{ name: string; status: string }[]>([])

  const refresh = useCallback(async () => {
    const data = await durably.getRuns({ limit: 20 })
    setRuns(data)
  }, [])

  useEffect(() => {
    refresh()
    onMount(refresh)
  }, [refresh, onMount])

  const showDetails = async (runId: string) => {
    const run = await durably.getRun(runId)
    if (run) {
      setSelectedRun(run)
      const stepsData = await durably.storage.getSteps(runId)
      setSteps(stepsData.map((s) => ({ name: s.name, status: s.status })))
    }
  }

  const handleRetry = async (runId: string) => {
    await durably.retry(runId)
    refresh()
  }

  const handleCancel = async (runId: string) => {
    await durably.cancel(runId)
    refresh()
  }

  const handleDelete = async (runId: string) => {
    await durably.deleteRun(runId)
    setSelectedRun(null)
    refresh()
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <h2 style={{ margin: 0 }}>Runs</h2>
        <button
          type="button"
          onClick={refresh}
          style={{ padding: '0.25rem 0.5rem', fontSize: '0.875rem' }}
        >
          ↻ Refresh
        </button>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>ID</th>
            <th style={styles.th}>Job</th>
            <th style={styles.th}>Status</th>
            <th style={styles.th}>Created</th>
            <th style={styles.th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                style={{
                  ...styles.td,
                  textAlign: 'center',
                  padding: '2rem',
                  color: '#666',
                }}
              >
                No runs yet
              </td>
            </tr>
          ) : (
            runs.map((run) => (
              <tr key={run.id}>
                <td style={{ ...styles.td, ...styles.runId }}>
                  {run.id.slice(0, 8)}...
                </td>
                <td style={styles.td}>{run.jobName}</td>
                <td style={styles.td}>
                  <span style={styles.badge(run.status)}>{run.status}</span>
                </td>
                <td style={styles.td}>{formatDate(run.createdAt)}</td>
                <td style={styles.td}>
                  <button
                    type="button"
                    style={styles.actionBtn}
                    onClick={() => showDetails(run.id)}
                  >
                    View
                  </button>
                  {run.status === 'failed' && (
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => handleRetry(run.id)}
                    >
                      Retry
                    </button>
                  )}
                  {(run.status === 'running' || run.status === 'pending') && (
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => handleCancel(run.id)}
                    >
                      Cancel
                    </button>
                  )}
                  {run.status !== 'running' && run.status !== 'pending' && (
                    <button
                      type="button"
                      style={styles.actionBtn}
                      onClick={() => handleDelete(run.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {selectedRun && (
        <div style={styles.details}>
          <h3 style={{ margin: '0 0 1rem' }}>Run Details</h3>
          <p>
            <strong>ID:</strong>{' '}
            <span style={styles.runId}>{selectedRun.id}</span>
          </p>
          <p>
            <strong>Job:</strong> {selectedRun.jobName}
          </p>
          <p>
            <strong>Status:</strong>{' '}
            <span style={styles.badge(selectedRun.status)}>
              {selectedRun.status}
            </span>
          </p>
          <p>
            <strong>Created:</strong> {formatDate(selectedRun.createdAt)}
          </p>
          {selectedRun.progress && (
            <p>
              <strong>Progress:</strong> {selectedRun.progress.current}
              {selectedRun.progress.total
                ? `/${selectedRun.progress.total}`
                : ''}{' '}
              {selectedRun.progress.message || ''}
            </p>
          )}
          {selectedRun.error && (
            <p>
              <strong>Error:</strong>{' '}
              <span style={{ color: '#dc3545' }}>{selectedRun.error}</span>
            </p>
          )}
          {selectedRun.output !== null && (
            <>
              <p>
                <strong>Output:</strong>
              </p>
              <pre style={styles.result(false)}>
                {JSON.stringify(selectedRun.output, null, 2)}
              </pre>
            </>
          )}
          <p>
            <strong>Payload:</strong>
          </p>
          <pre style={styles.result(false)}>
            {JSON.stringify(selectedRun.payload, null, 2)}
          </pre>
          {steps.length > 0 && (
            <>
              <p>
                <strong>Steps:</strong>
              </p>
              <ul style={styles.stepsList}>
                {steps.map((s) => (
                  <li key={s.name} style={styles.stepsItem}>
                    <span>{s.name}</span>
                    <span
                      style={styles.badge(
                        s.status === 'completed' ? 'completed' : 'failed',
                      )}
                    >
                      {s.status}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Main App
export function App() {
  const { status, step, result, run, setRefreshDashboard } = useDurably()
  const [activeTab, setActiveTab] = useState<'demo' | 'dashboard'>('demo')
  const isProcessing = status === 'running' || status === 'resuming'

  const statusText: Record<typeof status, string> = {
    init: 'Initializing...',
    ready: 'Ready',
    running: 'Running',
    resuming: '🔄 Resuming interrupted job...',
    done: '✓ Completed',
    error: '✗ Failed',
  }

  return (
    <div style={styles.container}>
      <h1>Durably React Example</h1>

      <div style={styles.tabs}>
        <button
          type="button"
          style={styles.tab(activeTab === 'demo')}
          onClick={() => setActiveTab('demo')}
        >
          Demo
        </button>
        <button
          type="button"
          style={styles.tab(activeTab === 'dashboard')}
          onClick={() => setActiveTab('dashboard')}
        >
          Dashboard
        </button>
      </div>

      {activeTab === 'demo' && (
        <>
          <div style={styles.buttons}>
            <button
              type="button"
              onClick={run}
              disabled={status === 'init' || isProcessing}
            >
              Run Job
            </button>
            <button
              type="button"
              onClick={() => location.reload()}
              disabled={status === 'init'}
            >
              Reload Page
            </button>
            <button
              type="button"
              onClick={async () => {
                await durably.stop()
                await deleteDatabaseFile()
                location.reload()
              }}
              disabled={isProcessing}
            >
              Reset Database
            </button>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <div>
              Status: <strong>{statusText[status]}</strong>
            </div>
            {step && (
              <div style={{ color: '#666', marginTop: '0.5rem' }}>
                Step: {step}
              </div>
            )}
          </div>

          {result && (
            <pre style={styles.result(status === 'error')}>{result}</pre>
          )}
        </>
      )}

      {activeTab === 'dashboard' && <Dashboard onMount={setRefreshDashboard} />}
    </div>
  )
}
