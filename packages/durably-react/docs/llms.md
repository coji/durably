# Durably React - LLM Documentation

> React bindings for Durably - step-oriented resumable batch execution.

## Overview

`@coji/durably-react` provides React hooks for triggering and monitoring Durably jobs. It supports two modes:

1. **Browser-complete mode**: Run Durably entirely in the browser with SQLite WASM
2. **Server-connected mode**: Connect to a remote Durably server via SSE

## Installation

```bash
# Browser-complete mode
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (client only)
npm install @coji/durably-react
```

## Browser-Complete Mode

### DurablyProvider

Wraps your app and provides the Durably instance to all hooks:

```tsx
import { Suspense } from 'react'
import { DurablyProvider } from '@coji/durably-react'
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

// Create and initialize Durably
async function initDurably() {
  const sqlocal = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({ dialect: sqlocal.dialect })
  await durably.migrate()
  return durably
}

const durablyPromise = initDurably()

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <DurablyProvider durably={durablyPromise}>
        <MyComponent />
      </DurablyProvider>
    </Suspense>
  )
}

// Or use the fallback prop
function AppAlt() {
  return (
    <DurablyProvider durably={durablyPromise} fallback={<div>Loading...</div>}>
      <MyComponent />
    </DurablyProvider>
  )
}
```

**Props:**

- `durably: Durably | Promise<Durably>` - Durably instance or Promise
- `autoStart?: boolean` - Auto-start worker (default: true)
- `onReady?: (durably: Durably) => void` - Callback when ready
- `fallback?: ReactNode` - Fallback to show while Promise resolves

### useDurably

Access the Durably instance directly:

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

Trigger and monitor a job:

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
    isCancelled,
    currentRunId,
    reset,
  } = useJob(myJob, {
    initialRunId: undefined,
    autoResume: true, // Auto-resume pending/running jobs (default: true)
    followLatest: true, // Switch to tracking new runs (default: true)
  })

  // Trigger job
  const handleClick = async () => {
    const { runId } = await trigger({ value: 'test' })
    console.log('Started:', runId)
  }

  // Or trigger and wait for result
  const handleSync = async () => {
    const { runId, output } = await triggerAndWait({ value: 'test' })
    console.log('Result:', output.result)
  }

  return (
    <div>
      <button onClick={handleClick} disabled={!isReady || isRunning}>
        Run
      </button>
      <p>Status: {status}</p>
      {progress && (
        <p>
          Progress: {progress.current}/{progress.total}
        </p>
      )}
      {isCompleted && <p>Result: {output?.result}</p>}
      {isFailed && <p>Error: {error}</p>}
      <button onClick={reset}>Reset</button>
    </div>
  )
}
```

**Options:**

```ts
interface UseJobOptions {
  initialRunId?: string // Initial Run ID to subscribe to
  autoResume?: boolean // Auto-resume pending/running jobs (default: true)
  followLatest?: boolean // Switch to tracking new runs (default: true)
}
```

**Return type:**

```ts
interface UseJobResult<TInput, TOutput> {
  isReady: boolean
  trigger: (input: TInput) => Promise<{ runId: string }>
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | null
  output: TOutput | null
  error: string | null
  logs: LogEntry[]
  progress: Progress | null
  isRunning: boolean
  isPending: boolean
  isCompleted: boolean
  isFailed: boolean
  isCancelled: boolean
  currentRunId: string | null
  reset: () => void
}
```

### useJobRun

Subscribe to an existing run by ID:

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

**Return type:**

```ts
interface UseJobRunResult<TOutput> {
  isReady: boolean
  status: RunStatus | null
  output: TOutput | null
  error: string | null
  progress: Progress | null
  logs: LogEntry[]
  isRunning: boolean
  isPending: boolean
  isCompleted: boolean
  isFailed: boolean
  isCancelled: boolean
}
```

### useJobLogs

Subscribe to logs from a run:

```tsx
import { useJobLogs } from '@coji/durably-react'

function LogViewer({ runId }: { runId: string | null }) {
  const { isReady, logs, clearLogs } = useJobLogs({
    runId,
    maxLogs: 100, // Optional: limit stored logs
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

**Return type:**

```ts
interface UseJobLogsResult {
  isReady: boolean
  logs: LogEntry[]
  clearLogs: () => void
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
```

### useRuns

List runs with pagination and real-time updates:

```tsx
import { useRuns } from '@coji/durably-react'

function Dashboard() {
  const {
    isReady,
    runs,
    page,
    hasMore,
    isLoading,
    nextPage,
    prevPage,
    goToPage,
    refresh,
  } = useRuns({
    jobName: 'my-job', // Optional: filter by job
    status: 'running', // Optional: filter by status
    pageSize: 20, // Optional: items per page (default: 10)
    realtime: true, // Optional: subscribe to updates (default: true)
  })

  return (
    <div>
      {runs.map((run) => (
        <div key={run.id}>
          {run.jobName}: {run.status}
        </div>
      ))}
      <button onClick={prevPage} disabled={page === 0}>
        Prev
      </button>
      <button onClick={nextPage} disabled={!hasMore}>
        Next
      </button>
    </div>
  )
}
```

**Return type:**

```ts
interface UseRunsResult {
  isReady: boolean
  runs: Run[]
  page: number
  hasMore: boolean
  isLoading: boolean
  nextPage: () => void
  prevPage: () => void
  goToPage: (page: number) => void
  refresh: () => Promise<void>
}
```

## Server-Connected Mode

Import hooks from `@coji/durably-react/client` for server-connected mode.

### Client useJob

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
    { count: number } // Output type
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

### Client useJobRun

```tsx
import { useJobRun } from '@coji/durably-react/client'

function Component({ runId }: { runId: string }) {
  const { status, output, error, progress, logs } = useJobRun<{
    count: number
  }>({
    api: '/api/durably',
    runId,
  })

  return <div>Status: {status}</div>
}
```

### Client useJobLogs

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

### Server Handler Setup

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

// Define and register jobs
const syncJob = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    // Job logic
    return { count: 42 }
  },
})
durably.register({ syncJob })

await durably.migrate()
durably.start()

// Create handler
const handler = createDurablyHandler(durably)

// Express/Hono/etc route handlers
app.post('/api/durably/trigger', async (req) => {
  return handler.trigger(req)
})

app.get('/api/durably/subscribe', (req) => {
  return handler.subscribe(req)
})

app.post('/api/durably/cancel', async (req) => {
  return handler.cancel(req)
})

app.get('/api/durably/runs', async (req) => {
  return handler.getRuns(req)
})

app.get('/api/durably/runs/:runId', async (req) => {
  return handler.getRun(req)
})
```

### Client useRuns

List runs with pagination:

```tsx
import { useRuns } from '@coji/durably-react/client'

function Dashboard() {
  const {
    runs,
    page,
    hasMore,
    isLoading,
    nextPage,
    prevPage,
    goToPage,
    refresh,
  } = useRuns({
    api: '/api/durably',
    jobName: 'sync-data', // Optional: filter by job
    status: 'running', // Optional: filter by status
    pageSize: 20, // Optional: items per page
  })

  return (
    <div>
      {runs.map((run) => (
        <div key={run.id}>
          {run.jobName}: {run.status}
        </div>
      ))}
    </div>
  )
}
```

### Client useRunActions

Get run details with steps and actions:

```tsx
import { useRunActions } from '@coji/durably-react/client'

function RunDetail({ runId }: { runId: string }) {
  const { run, steps, isLoading, cancel, retry, deleteRun } = useRunActions({
    api: '/api/durably',
    runId,
  })

  if (!run) return <div>Loading...</div>

  return (
    <div>
      <h2>Run: {run.id}</h2>
      <p>Status: {run.status}</p>
      <h3>Steps:</h3>
      <ul>
        {steps.map((step) => (
          <li key={step.index}>
            {step.name}: {step.status}
          </li>
        ))}
      </ul>
      {run.status === 'running' && <button onClick={cancel}>Cancel</button>}
      {run.status === 'failed' && <button onClick={retry}>Retry</button>}
      <button onClick={deleteRun}>Delete</button>
    </div>
  )
}
```

### Type-Safe Client Factories

#### createJobHooks

Create type-safe hooks for a single job:

```tsx
import type { importCsvJob } from '~/lib/durably.server'
import { createJobHooks } from '@coji/durably-react/client'

const importCsv = createJobHooks<typeof importCsvJob>({
  api: '/api/durably',
  jobName: 'import-csv',
})

function CsvImporter() {
  const { trigger, output, progress, isRunning } = importCsv.useJob()

  return (
    <button onClick={() => trigger({ rows: [...] })}>
      Import
    </button>
  )
}
```

#### createDurablyClient

Create a type-safe client for all registered jobs:

```tsx
// Server: register jobs (app/lib/durably.server.ts)
export const jobs = durably.register({
  importCsv: importCsvJob,
  syncUsers: syncUsersJob,
})

// Client: create typed client (app/lib/durably.client.ts)
import type { jobs } from '~/lib/durably.server'
import { createDurablyClient } from '@coji/durably-react/client'

export const durably = createDurablyClient<typeof jobs>({
  api: '/api/durably',
})

// In your component - fully type-safe with autocomplete
function CsvImporter() {
  const { trigger, output, isRunning } = durably.importCsv.useJob()

  return (
    <button onClick={() => trigger({ rows: [...] })}>
      Import
    </button>
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
```

## Common Patterns

### Loading States

```tsx
function Component() {
  const { isReady, isRunning, trigger } = useJob(myJob)

  if (!isReady) return <Spinner />

  return (
    <button onClick={() => trigger({ value: 'test' })} disabled={isRunning}>
      {isRunning ? 'Processing...' : 'Start'}
    </button>
  )
}
```

### Error Handling

```tsx
function Component() {
  const { trigger, error, isFailed, reset } = useJob(myJob)

  const handleClick = async () => {
    try {
      await trigger({ value: 'test' })
    } catch (e) {
      console.error('Trigger failed:', e)
    }
  }

  if (isFailed) {
    return (
      <div>
        <p>Error: {error}</p>
        <button onClick={reset}>Try Again</button>
      </div>
    )
  }

  return <button onClick={handleClick}>Run</button>
}
```

### Progress Tracking

```tsx
function Component() {
  const { trigger, progress, isRunning } = useJob(progressJob)

  return (
    <div>
      <button onClick={() => trigger({})}>Start</button>
      {isRunning && progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <p>{progress.message}</p>
        </div>
      )}
    </div>
  )
}
```

### Reconnecting to Existing Run

```tsx
function Component({ existingRunId }: { existingRunId?: string }) {
  const { status, output } = useJob(myJob, {
    initialRunId: existingRunId,
  })

  // Will automatically subscribe to the existing run
  return <div>Status: {status}</div>
}
```

## License

MIT
