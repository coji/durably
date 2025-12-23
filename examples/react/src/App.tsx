/**
 * React Example for Durably
 *
 * Simple example showing basic durably usage with React.
 * Demonstrates job resumption after page reload.
 *
 * Structure follows the pattern that will be provided by @coji/durably-react:
 * - lib/durably.ts: Singleton durably instance
 * - hooks/useDurably.ts: React lifecycle management hook
 * - jobs/*.ts: Job definitions
 */

import { useState } from 'react'
import { Dashboard } from './Dashboard'
import { useDurably } from './hooks/useDurably'
import { processImage } from './jobs/processImage'
import { deleteDatabaseFile, durably } from './lib/durably'
import { styles } from './styles'

// Links
const GITHUB_REPO = 'https://github.com/coji/durably'
const SOURCE_CODE = `${GITHUB_REPO}/tree/main/examples/react`

// Main App
export function App() {
  const {
    status,
    currentStep,
    result,
    markUserTriggered,
    setRefreshDashboard,
    refreshDashboard,
  } = useDurably()
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

  const handleRun = async () => {
    markUserTriggered()
    await processImage.trigger({ filename: 'photo.jpg', width: 800 })
    refreshDashboard()
  }

  const handleReset = async () => {
    await durably.stop()
    await deleteDatabaseFile()
    location.reload()
  }

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
        </div>
      </header>

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
              onClick={handleRun}
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
            <button type="button" onClick={handleReset} disabled={isProcessing}>
              Reset Database
            </button>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <div>
              Status: <strong>{statusText[status]}</strong>
            </div>
            {currentStep && (
              <div style={{ color: '#666', marginTop: '0.5rem' }}>
                Step: {currentStep}
              </div>
            )}
          </div>

          {result && (
            <pre style={styles.result(status === 'error')}>{result}</pre>
          )}
        </>
      )}

      {activeTab === 'dashboard' && (
        <Dashboard durably={durably} onMount={setRefreshDashboard} />
      )}
    </div>
  )
}
