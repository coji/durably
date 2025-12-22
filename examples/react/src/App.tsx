/**
 * React Example for Durably
 *
 * Simple example showing basic durably usage with React.
 * Demonstrates job resumption after page reload.
 */

import { createDurably } from '@coji/durably'
import { useEffect, useRef, useState } from 'react'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'
import { Dashboard } from './Dashboard'
import { styles } from './styles'

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
    input: z.object({ filename: z.string(), width: z.number() }),
    output: z.object({ url: z.string(), size: z.number() }),
  },
  async (step, payload) => {
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
    await processImage.trigger({ filename: 'photo.jpg', width: 800 })
    refreshDashboardRef.current?.()
  }

  const setRefreshDashboard = (fn: () => void) => {
    refreshDashboardRef.current = fn
  }

  return { status, step, result, run, setRefreshDashboard }
}

// Links
const GITHUB_REPO = 'https://github.com/coji/durably'
const SOURCE_CODE = `${GITHUB_REPO}/tree/main/examples/react`

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

      {activeTab === 'dashboard' && (
        <Dashboard durably={durably} onMount={setRefreshDashboard} />
      )}
    </div>
  )
}
