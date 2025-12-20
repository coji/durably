/**
 * React Example for Durably
 *
 * This example demonstrates using Durably with React and SQLocal (SQLite WASM + OPFS).
 * It uses a singleton pattern to safely handle React StrictMode's double mount behavior.
 */

import { createDurably, type Durably, type JobHandle } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Singleton instance to handle StrictMode
const DB_NAME = 'example.sqlite3'
const sqlocal = new SQLocalKysely(DB_NAME)
const { dialect, deleteDatabaseFile } = sqlocal

let durably: Durably | null = null
let processDataJob: JobHandle<
  'process-data',
  { items: string[] },
  { processed: number }
> | null = null

function getDurably() {
  if (!durably) {
    durably = createDurably({
      dialect,
      pollingInterval: 100,
    })
  }
  return durably
}

function getProcessDataJob(instance: Durably) {
  if (!processDataJob) {
    processDataJob = instance.defineJob(
      {
        name: 'process-data',
        input: z.object({ items: z.array(z.string()) }),
        output: z.object({ processed: z.number() }),
      },
      async (ctx, payload) => {
        ctx.progress(0, payload.items.length)

        for (let i = 0; i < payload.items.length; i++) {
          await ctx.run(`process-${i}`, async () => {
            await new Promise((r) => setTimeout(r, 500))
            return `Processed: ${payload.items[i]}`
          })
          ctx.progress(
            i + 1,
            payload.items.length,
            `Processed ${payload.items[i]}`,
          )
        }

        return { processed: payload.items.length }
      },
    )
  }
  return processDataJob
}

interface Stats {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
}

export function App() {
  const [status, setStatus] = useState('Initializing...')
  const [progress, setProgress] = useState('-')
  const [result, setResult] = useState('')
  const [stats, setStats] = useState<Stats | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isReady, setIsReady] = useState(false)
  const cleanedUp = useRef(false)

  const updateStats = useCallback(async () => {
    try {
      const instance = getDurably()
      const runs = await instance.storage.getRuns()
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
    const instance = getDurably()

    async function init() {
      try {
        await instance.migrate()
        if (cleanedUp.current) return

        // Subscribe to events
        const unsubscribes = [
          instance.on('step:complete', (event) => {
            if (!cleanedUp.current) {
              setStatus(`Step ${event.stepName} completed`)
            }
          }),
          instance.on('run:complete', (event) => {
            if (!cleanedUp.current) {
              setStatus('Completed!')
              setResult(JSON.stringify(event.output, null, 2))
              setIsRunning(false)
              updateStats()
            }
          }),
          instance.on('run:fail', (event) => {
            if (!cleanedUp.current) {
              setStatus(`Failed: ${event.error}`)
              setIsRunning(false)
              updateStats()
            }
          }),
        ]

        instance.start()
        setIsReady(true)
        setStatus('Ready')
        await updateStats()

        return () => {
          for (const unsubscribe of unsubscribes) {
            unsubscribe()
          }
        }
      } catch (err) {
        if (!cleanedUp.current) {
          setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
        }
      }
    }

    const cleanupPromise = init()

    return () => {
      cleanedUp.current = true
      cleanupPromise.then((cleanup) => cleanup?.())
      instance.stop()
    }
  }, [updateStats])

  const runJob = async () => {
    const instance = getDurably()
    const job = getProcessDataJob(instance)

    setIsRunning(true)
    setStatus('Running...')
    setProgress('0/3')
    setResult('')

    const run = await job.trigger({
      items: ['item1', 'item2', 'item3'],
    })

    await updateStats()

    const interval = setInterval(async () => {
      if (cleanedUp.current) {
        clearInterval(interval)
        return
      }

      const current = await job.getRun(run.id)
      if (current?.progress) {
        setProgress(`${current.progress.current}/${current.progress.total}`)
        if (current.progress.message) {
          setStatus(current.progress.message)
        }
      }

      if (current?.status === 'completed' || current?.status === 'failed') {
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

    try {
      const instance = getDurably()
      await instance.stop()
      await deleteDatabaseFile()
      setStatus('Database deleted. Reloading...')
      setTimeout(() => location.reload(), 500)
    } catch (err) {
      setStatus(`Reset failed: ${err instanceof Error ? err.message : 'Unknown'}`)
      setIsReady(true)
    }
  }

  return (
    <>
      <h1>Durably React Example</h1>
      <div>
        <button type="button" onClick={runJob} disabled={!isReady || isRunning}>
          Run Job
        </button>
        <button type="button" onClick={updateStats} disabled={!isReady}>
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
      <p>
        Status: <span>{status}</span>
      </p>
      <p className="progress">
        Progress: <span>{progress}</span>
      </p>
      <div className="stats">
        {stats ? (
          <>
            <strong>Database Stats:</strong>
            <br />
            Total runs: {stats.total}
            <br />
            Pending: {stats.pending} | Running: {stats.running} | Completed:{' '}
            {stats.completed} | Failed: {stats.failed}
          </>
        ) : (
          'Stats unavailable'
        )}
      </div>
      <pre>{result}</pre>
    </>
  )
}
