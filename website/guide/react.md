# React

This guide covers using Durably in React applications with best practices for hooks, StrictMode, and state management.

## Basic Setup

### Creating a Durably Instance

Create a singleton instance outside of React components:

```tsx
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect } = new SQLocalKysely('app.sqlite3')

export const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})
```

### Initialization Hook

```tsx
// hooks/useDurably.ts
import { useEffect, useState } from 'react'
import { durably } from '../lib/durably'

export function useDurably() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      await durably.migrate()
      if (!cancelled) {
        durably.start()
        setReady(true)
      }
    }
    init()

    return () => {
      cancelled = true
      durably.stop()
    }
  }, [])

  return { ready, durably }
}
```

## StrictMode Compatibility

React StrictMode mounts and unmounts components twice in development. Durably handles this gracefully, but you should follow these patterns:

### Use a Cancelled Flag

```tsx
useEffect(() => {
  let cancelled = false

  async function init() {
    await durably.migrate()
    if (cancelled) return  // Check before state updates

    durably.start()
    setReady(true)
  }
  init()

  return () => {
    cancelled = true
    durably.stop()
  }
}, [])
```

### Singleton Pattern

For shared state across components:

```tsx
// lib/durably.ts
let instance: Durably | null = null
let initPromise: Promise<void> | null = null

export async function getDurably() {
  if (!instance) {
    const { dialect } = new SQLocalKysely('app.sqlite3')
    instance = createDurably({ dialect })
    initPromise = instance.migrate()
  }
  await initPromise
  return instance
}

// hooks/useDurably.ts
export function useDurably() {
  const [durably, setDurably] = useState<Durably | null>(null)

  useEffect(() => {
    let cancelled = false

    getDurably().then((d) => {
      if (!cancelled) {
        d.start()
        setDurably(d)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  return durably
}
```

## Job Status Tracking

### Track Individual Job Runs

```tsx
function useJobStatus(job: JobHandle<string, unknown, unknown>) {
  const [runs, setRuns] = useState<Run[]>([])

  useEffect(() => {
    // Load initial runs
    job.getRuns().then(setRuns)

    // Subscribe to updates
    const unsubs = [
      durably.on('run:start', async (e) => {
        const run = await job.getRun(e.runId)
        if (run) setRuns((prev) => [...prev, run])
      }),
      durably.on('run:complete', async (e) => {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.runId ? { ...r, status: 'completed', output: e.output } : r
          )
        )
      }),
      durably.on('run:fail', async (e) => {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.runId ? { ...r, status: 'failed', error: e.error } : r
          )
        )
      }),
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [job])

  return runs
}
```

### Processing State Hook

```tsx
function useProcessingState() {
  const [processing, setProcessing] = useState(false)
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)

  useEffect(() => {
    const unsubs = [
      durably.on('run:start', (e) => {
        setProcessing(true)
        setCurrentRunId(e.runId)
      }),
      durably.on('run:complete', () => {
        setProcessing(false)
        setCurrentRunId(null)
      }),
      durably.on('run:fail', () => {
        setProcessing(false)
        setCurrentRunId(null)
      }),
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [])

  return { processing, currentRunId }
}
```

## Progress Tracking

### With Progress Events

```tsx
function useProgress(runId: string | null) {
  const [progress, setProgress] = useState<{
    current: number
    total?: number
    message?: string
  } | null>(null)

  useEffect(() => {
    if (!runId) {
      setProgress(null)
      return
    }

    const unsub = durably.on('run:progress', (e) => {
      if (e.runId === runId) {
        setProgress({
          current: e.current,
          total: e.total,
          message: e.message,
        })
      }
    })

    return unsub
  }, [runId])

  return progress
}
```

### Progress UI Component

```tsx
function ProgressBar({ runId }: { runId: string | null }) {
  const progress = useProgress(runId)

  if (!progress) return null

  const percent = progress.total
    ? Math.round((progress.current / progress.total) * 100)
    : null

  return (
    <div className="progress">
      {percent !== null && (
        <div className="bar" style={{ width: `${percent}%` }} />
      )}
      <span>{progress.message || `${progress.current}/${progress.total || '?'}`}</span>
    </div>
  )
}
```

## Complete Example

```tsx
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { durably } from './lib/durably'

// Define job outside component
const processDataJob = durably.defineJob(
  {
    name: 'process-data',
    input: z.object({ items: z.array(z.string()) }),
    output: z.object({ processed: z.number() }),
  },
  async (context, payload) => {
    let processed = 0

    for (const item of payload.items) {
      await context.run(`process-${item}`, async () => {
        // Simulate work
        await new Promise((r) => setTimeout(r, 500))
        processed++
      })
      context.progress(processed, payload.items.length)
    }

    return { processed }
  },
)

function App() {
  const [ready, setReady] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState<{ processed: number } | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      await durably.migrate()
      if (cancelled) return
      durably.start()
      setReady(true)
    }
    init()

    const unsubs = [
      durably.on('run:start', () => setProcessing(true)),
      durably.on('run:complete', (e) => {
        setProcessing(false)
        setResult(e.output as { processed: number })
      }),
      durably.on('run:fail', () => setProcessing(false)),
    ]

    return () => {
      cancelled = true
      unsubs.forEach((fn) => fn())
      durably.stop()
    }
  }, [])

  const handleProcess = async () => {
    setResult(null)
    await processDataJob.trigger({
      items: ['item-1', 'item-2', 'item-3'],
    })
  }

  if (!ready) {
    return <div>Initializing...</div>
  }

  return (
    <div>
      <button onClick={handleProcess} disabled={processing}>
        {processing ? 'Processing...' : 'Process Data'}
      </button>

      {result && <p>Processed {result.processed} items</p>}
    </div>
  )
}
```

## Context Provider Pattern

For larger applications:

```tsx
// context/DurablyContext.tsx
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { durably, type Durably } from '../lib/durably'

interface DurablyContextValue {
  durably: Durably
  ready: boolean
}

const DurablyContext = createContext<DurablyContextValue | null>(null)

export function DurablyProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    durably.migrate().then(() => {
      if (!cancelled) {
        durably.start()
        setReady(true)
      }
    })

    return () => {
      cancelled = true
      durably.stop()
    }
  }, [])

  return (
    <DurablyContext.Provider value={{ durably, ready }}>
      {children}
    </DurablyContext.Provider>
  )
}

export function useDurablyContext() {
  const context = useContext(DurablyContext)
  if (!context) {
    throw new Error('useDurablyContext must be used within DurablyProvider')
  }
  return context
}
```

Usage:

```tsx
// App.tsx
import { DurablyProvider, useDurablyContext } from './context/DurablyContext'

function JobRunner() {
  const { ready } = useDurablyContext()

  if (!ready) return <div>Loading...</div>

  return <button onClick={() => myJob.trigger({ data: 'test' })}>Run</button>
}

function App() {
  return (
    <DurablyProvider>
      <JobRunner />
    </DurablyProvider>
  )
}
```

## Best Practices

1. **Create durably instance outside components** - Avoid creating instances inside useEffect
2. **Use cancelled flags** - Prevent state updates after unmount
3. **Clean up event listeners** - Always unsubscribe in cleanup
4. **Define jobs at module level** - Jobs should be defined once, not per render
5. **Handle StrictMode** - Test your app in development mode to catch issues early
