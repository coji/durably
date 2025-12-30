/**
 * React Example for Durably
 *
 * Demonstrates @coji/durably-react usage with:
 * - DurablyProvider for context
 * - useJob hook for triggering and monitoring jobs
 * - useDurably hook for direct Durably access
 */

import {
  DurablyProvider,
  useDurably,
  useJob,
  type LogEntry,
} from '@coji/durably-react'
import { useState } from 'react'
import { SQLocalKysely } from 'sqlocal/kysely'
import { Dashboard } from './Dashboard'
import { processImageJob } from './jobs/processImage'
import { styles } from './styles'

// Links
const GITHUB_REPO = 'https://github.com/coji/durably'
const SOURCE_CODE = `${GITHUB_REPO}/tree/main/examples/react`

// SQLocal instance for database operations
const sqlocal = new SQLocalKysely('example.sqlite3')

// Durably configuration
const dialectFactory = () => sqlocal.dialect
const durablyOptions = {
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}

function AppContent() {
  const [showInfo, setShowInfo] = useState(false)
  const { durably } = useDurably()
  const { trigger, status, output, error, progress, logs, isRunning, isReady } =
    useJob(processImageJob)

  const handleRun = async () => {
    await trigger({ filename: 'photo.jpg', width: 800 })
  }

  const handleReset = async () => {
    if (durably) {
      await durably.stop()
    }
    await sqlocal.deleteDatabaseFile()
    location.reload()
  }

  const statusText =
    status === 'running'
      ? 'Running...'
      : status === 'completed'
        ? '✓ Completed'
        : status === 'failed'
          ? '✗ Failed'
          : status === 'pending'
            ? 'Pending...'
            : isReady
              ? 'Ready'
              : 'Initializing...'

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Durably React Example</h1>
        <div style={styles.links}>
          <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <span style={styles.linkSeparator}>|</span>
          <a href={SOURCE_CODE} target="_blank" rel="noopener noreferrer">
            Source Code
          </a>
          <span style={styles.linkSeparator}>|</span>
          <button
            type="button"
            onClick={() => setShowInfo(!showInfo)}
            style={{
              background: 'none',
              border: 'none',
              color: '#0066cc',
              cursor: 'pointer',
              padding: 0,
              font: 'inherit',
            }}
          >
            {showInfo ? 'Hide Info' : 'Show Info'}
          </button>
        </div>
      </header>

      {showInfo && (
        <div
          style={{
            background: '#f5f5f5',
            padding: '1rem',
            borderRadius: '4px',
            marginBottom: '1rem',
            fontSize: '0.875rem',
          }}
        >
          <p style={{ margin: '0 0 0.5rem' }}>
            This example uses <code>@coji/durably-react</code> for seamless
            React integration:
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.5rem' }}>
            <li>
              <code>DurablyProvider</code> - Context provider with auto
              migration and worker start
            </li>
            <li>
              <code>useJob</code> - Hook for triggering jobs and real-time
              status updates
            </li>
            <li>
              <code>useDurably</code> - Direct access to Durably instance
            </li>
          </ul>
        </div>
      )}

      <div style={styles.buttons}>
        <button
          type="button"
          onClick={handleRun}
          disabled={!isReady || isRunning}
        >
          Run Job
        </button>
        <button
          type="button"
          onClick={() => location.reload()}
          disabled={!isReady}
        >
          Reload Page
        </button>
        <button type="button" onClick={handleReset} disabled={isRunning}>
          Reset Database
        </button>
      </div>

      <div className="main-grid">
        <div>
          <h2 style={{ margin: '0 0 1rem' }}>Job Status</h2>
          <div style={{ marginBottom: '1rem' }}>
            <div>
              Status: <strong>{statusText}</strong>
            </div>
            {status && (
              <div style={{ color: '#666', marginTop: '0.5rem' }}>
                Run status: {status}
              </div>
            )}
            {progress && (
              <div style={{ color: '#666', marginTop: '0.5rem' }}>
                Progress: {progress.current}
                {progress.total ? `/${progress.total}` : ''}{' '}
                {progress.message || ''}
              </div>
            )}
          </div>

          {output && (
            <pre style={styles.result(false)}>
              {JSON.stringify(output, null, 2)}
            </pre>
          )}

          {error && <pre style={styles.result(true)}>{error}</pre>}

          {logs.length > 0 && (
            <div style={{ marginTop: '1rem' }}>
              <strong>Logs:</strong>
              <ul style={{ margin: '0.5rem 0', padding: '0 0 0 1.5rem' }}>
                {logs.map((log: LogEntry) => (
                  <li
                    key={log.id}
                    style={{ fontSize: '0.875rem', color: '#666' }}
                  >
                    [{log.level}] {log.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div>
          <Dashboard />
        </div>
      </div>
    </div>
  )
}

export function App() {
  return (
    <DurablyProvider dialectFactory={dialectFactory} options={durablyOptions}>
      <AppContent />
    </DurablyProvider>
  )
}
