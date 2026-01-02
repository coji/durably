# durably-react

React bindings for Durably - hooks for triggering and monitoring jobs.

## Installation

```bash
# Browser-complete mode
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (client only)
npm install @coji/durably-react
```

## Browser-Complete Mode

Run Durably entirely in the browser using SQLite WASM.

### DurablyProvider

Wraps your app and initializes Durably.

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

// Create Durably instance
async function createBrowserDurably() {
  const { dialect } = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({ dialect, pollingInterval: 100 })
  durably.register({ myJob: myJobDef })
  await durably.migrate()
  return durably
}

const durablyPromise = createBrowserDurably()

function App() {
  return (
    <DurablyProvider durably={durablyPromise} fallback={<p>Loading...</p>}>
      <MyComponent />
    </DurablyProvider>
  )
}
```

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `durably` | `Durably \| Promise<Durably>` | required | Durably instance or Promise |
| `autoStart` | `boolean` | `true` | Auto-start worker on mount |
| `onReady` | `(durably: Durably) => void` | - | Callback when ready |
| `fallback` | `ReactNode` | - | Loading fallback (wraps in Suspense) |

### useDurably

Access the Durably instance directly.

```tsx
import { useDurably } from '@coji/durably-react'

function Component() {
  const { durably, isReady, error } = useDurably()

  if (!isReady) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  // Use durably instance directly
}
```

### useJob

Trigger and monitor a job.

```tsx
import { defineJob } from '@coji/durably'
import { useJob } from '@coji/durably-react'
import { z } from 'zod'

const myJob = defineJob({
  name: 'my-job',
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.number() }),
  run: async (step, payload) => {
    const data = await step.run('process', () => process(payload.value))
    return { result: data.length }
  },
})

function Component() {
  const {
    isReady,
    trigger,
    triggerAndWait,
    status,
    output,
    error,
    logs,
    progress,
    isRunning,
    isPending,
    isCompleted,
    isFailed,
    currentRunId,
    reset,
  } = useJob(myJob, { initialRunId: undefined })

  const handleClick = async () => {
    const { runId } = await trigger({ value: 'test' })
    console.log('Started:', runId)
  }

  return (
    <div>
      <button onClick={handleClick} disabled={!isReady || isRunning}>
        Run
      </button>
      <p>Status: {status}</p>
      {progress && <p>Progress: {progress.current}/{progress.total}</p>}
      {isCompleted && <p>Result: {output?.result}</p>}
      {isFailed && <p>Error: {error}</p>}
      <button onClick={reset}>Reset</button>
    </div>
  )
}
```

**Return Type:**

```ts
interface UseJobResult<TInput, TOutput> {
  isReady: boolean
  trigger: (input: TInput) => Promise<{ runId: string }>
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  status: 'pending' | 'running' | 'completed' | 'failed' | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
  isRunning: boolean
  isPending: boolean
  isCompleted: boolean
  isFailed: boolean
  currentRunId: string | null
  reset: () => void
}
```

### useJobRun

Subscribe to an existing run by ID.

```tsx
import { useJobRun } from '@coji/durably-react'

function RunMonitor({ runId }: { runId: string | null }) {
  const {
    isReady,
    status,
    output,
    error,
    progress,
    logs,
    isRunning,
    isCompleted,
    isFailed,
  } = useJobRun<{ result: number }>({ runId })

  if (!runId) return <div>No run selected</div>

  return (
    <div>
      <p>Status: {status}</p>
      {isCompleted && <p>Output: {JSON.stringify(output)}</p>}
    </div>
  )
}
```

### useJobLogs

Subscribe to logs from a run.

```tsx
import { useJobLogs } from '@coji/durably-react'

function LogViewer({ runId }: { runId: string | null }) {
  const { isReady, logs, clearLogs } = useJobLogs({
    runId,
    maxLogs: 100,
  })

  return (
    <div>
      <button onClick={clearLogs}>Clear Logs</button>
      <ul>
        {logs.map((log) => (
          <li key={log.id}>
            [{log.level}] {log.message}
            {log.data && <pre>{JSON.stringify(log.data)}</pre>}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

## Server-Connected Mode

Import hooks from `@coji/durably-react/client` for server-connected mode.

### useJob (Client)

```tsx
import { useJob } from '@coji/durably-react/client'

function Component() {
  const {
    isReady, // Always true in client mode
    trigger,
    triggerAndWait,
    status,
    output,
    error,
    logs,
    progress,
    isRunning,
    isCompleted,
    currentRunId,
    reset,
  } = useJob<
    { userId: string }, // Input type
    { count: number }   // Output type
  >({
    api: '/api/durably',
    jobName: 'sync-data',
  })

  const handleClick = async () => {
    const { runId } = await trigger({ userId: 'user_123' })
    console.log('Started:', runId)
  }

  return <button onClick={handleClick}>Sync</button>
}
```

### useJobRun (Client)

```tsx
import { useJobRun } from '@coji/durably-react/client'

function Component({ runId }: { runId: string }) {
  const { status, output, error, progress, logs } = useJobRun<{ count: number }>({
    api: '/api/durably',
    runId,
  })

  return <div>Status: {status}</div>
}
```

### useJobLogs (Client)

```tsx
import { useJobLogs } from '@coji/durably-react/client'

function Component({ runId }: { runId: string }) {
  const { logs, clearLogs } = useJobLogs({
    api: '/api/durably',
    runId,
    maxLogs: 50,
  })

  return (
    <ul>
      {logs.map((log) => (
        <li key={log.id}>{log.message}</li>
      ))}
    </ul>
  )
}
```

### Server Setup

On your server, use `createDurablyHandler` from `@coji/durably/server`:

```ts
import { createDurably, defineJob } from '@coji/durably'
import { createDurablyHandler } from '@coji/durably/server'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({ dialect })
const handler = createDurablyHandler(durably)

// Define and register jobs
const syncJobDef = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    // Job logic
    return { count: 0 }
  },
})

export const jobs = durably.register({ syncData: syncJobDef })

await durably.migrate()
durably.start()

// Use the unified handle() method (recommended)
app.all('/api/durably/*', async (req) => {
  return handler.handle(req, '/api/durably')
})

// Or use individual route handlers
app.post('/api/durably/trigger', (req) => handler.trigger(req))
app.get('/api/durably/subscribe', (req) => handler.subscribe(req))
app.get('/api/durably/runs', (req) => handler.runs(req))
app.get('/api/durably/runs/subscribe', (req) => handler.runsSubscribe(req))
```

### createDurablyClient

Create a type-safe client for all registered jobs:

```ts
// durably.client.ts
import { createDurablyClient } from '@coji/durably-react/client'
import type { jobs } from './durably.server'

export const durably = createDurablyClient<typeof jobs>({
  api: '/api/durably',
})

// Usage in components
function Component() {
  const { trigger, status, output } = durably.syncData.useJob()
  // trigger() is type-safe!
}
```

### useRuns

List and paginate job runs with real-time updates:

```tsx
import { useRuns } from '@coji/durably-react/client'

function Dashboard() {
  const {
    runs,
    isLoading,
    error,
    page,
    hasMore,
    nextPage,
    prevPage,
    refresh,
  } = useRuns({
    api: '/api/durably',
    jobName: 'sync-data', // optional filter
    pageSize: 10,
    realtime: true, // auto-refresh on SSE events
  })

  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id}>{run.status}</li>
      ))}
    </ul>
  )
}
```

### useRunActions

Perform actions on runs:

```tsx
import { useRunActions } from '@coji/durably-react/client'

function RunActions({ runId }: { runId: string }) {
  const {
    cancel,
    retry,
    deleteRun,
    getRun,
    getSteps,
    isLoading,
  } = useRunActions({ api: '/api/durably' })

  return (
    <div>
      <button onClick={() => cancel(runId)}>Cancel</button>
      <button onClick={() => retry(runId)}>Retry</button>
      <button onClick={() => deleteRun(runId)}>Delete</button>
    </div>
  )
}
```

## Type Definitions

```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

interface Progress {
  current: number
  total?: number
  message?: string
}

interface LogEntry {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
  timestamp: string
}

interface RunRecord {
  id: string
  jobName: string
  status: RunStatus
  payload: unknown
  output: unknown
  error: string | null
  progress: Progress | null
  createdAt: string
  updatedAt: string
}

interface StepRecord {
  name: string
  status: 'completed' | 'failed'
  output: unknown
  error: string | null
  startedAt: string
  completedAt: string | null
}
```
