/**
 * Dashboard Component for Durably React Example
 *
 * Displays run history with status, details, and action buttons.
 */

import type { Durably, Run } from '@coji/durably'
import { useCallback, useEffect, useState } from 'react'

// Styles
const styles = {
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
  result: {
    background: '#f5f5f5',
    padding: '1rem',
    borderRadius: '4px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap' as const,
  },
  stepsList: { listStyle: 'none', padding: 0, margin: 0 },
  stepsItem: {
    padding: '0.5rem',
    borderBottom: '1px solid #e0e0e0',
    display: 'flex',
    justifyContent: 'space-between',
  },
}

interface DashboardProps {
  durably: Durably
  onMount: (refresh: () => void) => void
}

export function Dashboard({ durably, onMount }: DashboardProps) {
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [steps, setSteps] = useState<{ name: string; status: string }[]>([])

  const refresh = useCallback(async () => {
    const data = await durably.getRuns({ limit: 20 })
    setRuns(data)
  }, [durably])

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
              <pre style={styles.result}>
                {JSON.stringify(selectedRun.output, null, 2)}
              </pre>
            </>
          )}
          <p>
            <strong>Payload:</strong>
          </p>
          <pre style={styles.result}>
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
