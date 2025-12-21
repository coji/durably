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
      }),
      durably.on('run:fail', (e) => {
        setResult(e.error)
        setStep(null)
        setStatus('error')
        userTriggered.current = false
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
  }

  return { status, step, result, run }
}

// UI
export function App() {
  const { status, step, result, run } = useDurably()
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
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Durably React Example</h1>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
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
          <div style={{ color: '#666', marginTop: '0.5rem' }}>Step: {step}</div>
        )}
      </div>

      {result && (
        <pre
          style={{
            background: status === 'error' ? '#fee' : '#f5f5f5',
            padding: '1rem',
            borderRadius: '4px',
          }}
        >
          {result}
        </pre>
      )}
    </div>
  )
}
