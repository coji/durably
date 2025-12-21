/**
 * React Example for Durably
 *
 * This example demonstrates using Durably with React and SQLocal (SQLite WASM + OPFS).
 * Jobs are defined at module level to ensure they're registered before the worker starts.
 */

import { createDurably } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Initialize Durably and define jobs at module level
const DB_NAME = 'example.sqlite3'
const sqlocal = new SQLocalKysely(DB_NAME)
const { dialect, deleteDatabaseFile } = sqlocal

const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000, // 3 seconds for demo
})

// Define job at module level (required for stale run recovery on reload)
const processImage = durably.defineJob(
  {
    name: 'process-image',
    input: z.object({ filename: z.string() }),
    output: z.object({ url: z.string() }),
  },
  async (ctx, payload) => {
    // Step 1: Download
    const data = await ctx.run('download', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { size: 1024000 }
    })

    // Step 2: Resize
    await ctx.run('resize', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { width: 800, height: 600, size: data.size / 2 }
    })

    // Step 3: Upload
    const uploaded = await ctx.run('upload', async () => {
      await new Promise((r) => setTimeout(r, 500))
      return { url: `https://cdn.example.com/${payload.filename}` }
    })

    return { url: uploaded.url }
  },
)

interface Stats {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
}

interface Progress {
  current: number
  total: number
}

type StatusState = 'default' | 'ready' | 'running' | 'completed' | 'failed'

export function App() {
  const [status, setStatus] = useState('Initializing...')
  const [statusState, setStatusState] = useState<StatusState>('default')
  const [progress, setProgress] = useState<Progress>({ current: 0, total: 0 })
  const [result, setResult] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const cleanedUp = useRef(false)

  const updateStats = useCallback(async () => {
    try {
      const runs = await durably.storage.getRuns()
      setStats({
        total: runs.length,
        pending: runs.filter((r) => r.status === 'pending').length,
        running: runs.filter((r) => r.status === 'running').length,
        completed: runs.filter((r) => r.status === 'completed').length,
        failed: runs.filter((r) => r.status === 'failed').length,
      })
    } catch {
      setStats(null)
    }
  }, [])

  useEffect(() => {
    cleanedUp.current = false

    async function init() {
      try {
        await durably.migrate()
        if (cleanedUp.current) return

        // Subscribe to events for real-time updates
        const unsubscribes = [
          durably.on('run:start', (event) => {
            if (!cleanedUp.current) {
              setStatus(`Running: ${event.jobName}`)
              setStatusState('running')
              updateStats()
            }
          }),
          durably.on('step:complete', (event) => {
            if (!cleanedUp.current) {
              setStatus(`Step: ${event.stepName} completed`)
            }
          }),
          durably.on('run:complete', (event) => {
            if (!cleanedUp.current) {
              setStatus('Completed!')
              setStatusState('completed')
              setResult(JSON.stringify(event.output, null, 2))
              setIsRunning(false)
              updateStats()
            }
          }),
          durably.on('run:fail', (event) => {
            if (!cleanedUp.current) {
              setStatus(`Failed: ${event.error}`)
              setStatusState('failed')
              setIsRunning(false)
              updateStats()
            }
          }),
        ]

        durably.start()
        setIsReady(true)
        setStatus('Ready')
        setStatusState('ready')
        await updateStats()

        // Set up periodic stats refresh to catch stale run recovery
        const statsInterval = setInterval(updateStats, 1000)

        return () => {
          for (const unsubscribe of unsubscribes) {
            unsubscribe()
          }
          clearInterval(statsInterval)
        }
      } catch (err) {
        if (!cleanedUp.current) {
          setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
          setStatusState('failed')
        }
      }
    }

    const cleanupPromise = init()

    return () => {
      cleanedUp.current = true
      cleanupPromise.then((cleanup) => cleanup?.())
      durably.stop()
    }
  }, [updateStats])

  const runJob = async () => {
    setIsRunning(true)
    setStatus('Queued...')
    setStatusState('default')
    setProgress({ current: 0, total: 3 })
    setResult('')

    const run = await processImage.trigger({
      filename: 'photo.jpg',
    })

    await updateStats()

    // Track step progress via polling
    let stepCount = 0
    const interval = setInterval(async () => {
      if (cleanedUp.current) {
        clearInterval(interval)
        return
      }

      const current = await processImage.getRun(run.id)

      if (current?.status === 'running') {
        const steps = await durably.storage.getSteps(run.id)
        const completedSteps = steps.filter((s) => s.status === 'completed').length
        if (completedSteps > stepCount) {
          stepCount = completedSteps
          setProgress({ current: stepCount, total: 3 })
        }
      }

      if (current?.status === 'completed' || current?.status === 'failed') {
        setProgress({ current: 3, total: 3 })
        clearInterval(interval)
      }
    }, 100)
  }

  const resetDatabase = async () => {
    if (!confirm('Delete the database and all data?')) {
      return
    }

    setIsReady(false)
    setStatus('Resetting...')
    setStatusState('default')

    try {
      await durably.stop()
      await deleteDatabaseFile()
      setStatus('Database deleted. Reloading...')
      setTimeout(() => location.reload(), 500)
    } catch (err) {
      setStatus(`Reset failed: ${err instanceof Error ? err.message : 'Unknown'}`)
      setStatusState('failed')
      setIsReady(true)
    }
  }

  const progressPercentage =
    progress.total > 0 ? (progress.current / progress.total) * 100 : 0

  return (
    <>
      <h1>Durably React Example</h1>

      <div className="button-group">
        <button type="button" onClick={runJob} disabled={!isReady || isRunning}>
          Run Job
        </button>
        <button
          type="button"
          className="secondary"
          onClick={updateStats}
          disabled={!isReady}
        >
          Refresh Stats
        </button>
        <button
          type="button"
          className="danger"
          onClick={resetDatabase}
          disabled={!isReady || isRunning}
        >
          Reset Database
        </button>
      </div>

      <div className="card">
        <div className="card-header">Status</div>
        <div className="status-row">
          <div className={`status-indicator ${statusState}`} />
          <span className="status-text">{status}</span>
        </div>
        <div className="progress-container">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          <div className="progress-text">
            {progress.total > 0
              ? `${progress.current} / ${progress.total}`
              : '-'}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">Database Stats</div>
        <div className="stats-grid">
          <div className="stat-item pending">
            <div className="stat-value">{stats?.pending ?? '-'}</div>
            <div className="stat-label">Pending</div>
          </div>
          <div className="stat-item running">
            <div className="stat-value">{stats?.running ?? '-'}</div>
            <div className="stat-label">Running</div>
          </div>
          <div className="stat-item completed">
            <div className="stat-value">{stats?.completed ?? '-'}</div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-item failed">
            <div className="stat-value">{stats?.failed ?? '-'}</div>
            <div className="stat-label">Failed</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">Result</div>
        <pre className="result">{result}</pre>
      </div>
    </>
  )
}
