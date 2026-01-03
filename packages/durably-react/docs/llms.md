# Durably React - LLM Documentation

> React bindings for Durably - step-oriented resumable batch execution.

## Requirements

- **React 19+** (uses `React.use()` for Promise resolution)

## Overview

`@coji/durably-react` provides React hooks for triggering and monitoring Durably jobs. It supports two modes:

1. **Browser Hooks**: Run Durably entirely in the browser with SQLite WASM (OPFS)
2. **Server Hooks**: Connect to a remote Durably server via HTTP/SSE

## Installation

```bash
# Browser mode - runs Durably in the browser
pnpm add @coji/durably-react @coji/durably kysely zod sqlocal

# Server mode - connects to Durably server
pnpm add @coji/durably-react
```

## Browser Hooks

Import from `@coji/durably-react` for browser-complete mode.

### DurablyProvider

Wraps your app and provides the Durably instance to all hooks:

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

// Create and initialize Durably
async function initDurably() {
  const sqlocal = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({ dialect: sqlocal.dialect })
  await durably.init()
  return durably
}

const durablyPromise = initDurably()

// With fallback prop (recommended)
function App() {
  return (
    <DurablyProvider durably={durablyPromise} fallback={<div>Loading...</div>}>
      <MyComponent />
    </DurablyProvider>
  )
}

// Or with external Suspense
function AppAlt() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <DurablyProvider durably={durablyPromise}>
        <MyComponent />
      </DurablyProvider>
    </Suspense>
  )
}
```

**Props:**

- `durably: Durably | Promise<Durably>` - Durably instance or Promise (should be initialized via `await durably.init()`)
- `fallback?: ReactNode` - Fallback to show while Promise resolves (wraps in Suspense automatically)

### useDurably

Access the Durably instance directly:

```tsx
import { useDurably } from '@coji/durably-react'

function Component() {
  const { durably } = useDurably()

  // Use durably instance directly
  const handleGetRuns = async () => {
    const runs = await durably.getRuns()
  }
}
```

**Return type:**

```ts
interface UseDurablyResult {
  durably: Durably
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
      <button onClick={handleClick} disabled={isRunning}>
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

Subscribe to logs from a run:

```tsx
import { useJobLogs } from '@coji/durably-react'

function LogViewer({ runId }: { runId: string | null }) {
  const { logs, clearLogs } = useJobLogs({
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

### useRuns

List runs with filtering and real-time updates:

```tsx
import { useRuns } from '@coji/durably-react'

function Dashboard() {
  const { runs, isLoading, refresh } = useRuns({
    jobName: 'my-job', // Optional: filter by job
    status: 'running', // Optional: filter by status
    limit: 10, // Optional: maximum runs
  })

  return (
    <div>
      <button onClick={refresh}>Refresh</button>
      {runs.map((run) => (
        <div key={run.id}>
          {run.jobName}: {run.status}
        </div>
      ))}
    </div>
  )
}
```

## Server Hooks

Import from `@coji/durably-react/client` for server-connected mode.

### createDurablyClient

Create a type-safe client for all registered jobs (recommended):

```tsx
// Server: register jobs (app/lib/durably.server.ts)
import { createDurably, createDurablyHandler } from '@coji/durably'

export const durably = createDurably({ dialect }).register({
  importCsv: importCsvJob,
  syncUsers: syncUsersJob,
})

export const durablyHandler = createDurablyHandler(durably)

await durably.init()

// Client: create typed client (app/lib/durably.client.ts)
import type { durably } from '~/lib/durably.server'
import { createDurablyClient } from '@coji/durably-react/client'

export const durablyClient = createDurablyClient<typeof durably>({
  api: '/api/durably',
})

// In your component - fully type-safe with autocomplete
function CsvImporter() {
  const { trigger, output, isRunning } = durablyClient.importCsv.useJob()

  return (
    <button onClick={() => trigger({ rows: [...] })} disabled={isRunning}>
      Import
    </button>
  )
}

// Subscribe to an existing run
function RunViewer({ runId }: { runId: string }) {
  const { status, output, progress } = durablyClient.importCsv.useRun(runId)
  return <div>Status: {status}</div>
}

// Subscribe to logs
function LogViewer({ runId }: { runId: string }) {
  const { logs } = durablyClient.importCsv.useLogs(runId)
  return <pre>{logs.map(l => l.message).join('\n')}</pre>
}
```

### Client useJob

Direct hook when not using `createDurablyClient`:

```tsx
import { useJob } from '@coji/durably-react/client'

function Component() {
  const {
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
    initialRunId: undefined, // Optional: resume existing run
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

### Client useRuns

List runs with pagination and real-time updates:

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

### Client useRunActions

Actions for runs (retry, cancel, delete):

```tsx
import { useRunActions } from '@coji/durably-react/client'

function RunActions({ runId, status }: { runId: string; status: string }) {
  const { retry, cancel, deleteRun, getRun, getSteps, isLoading, error } =
    useRunActions({
      api: '/api/durably',
    })

  return (
    <div>
      {(status === 'failed' || status === 'cancelled') && (
        <button onClick={() => retry(runId)} disabled={isLoading}>
          Retry
        </button>
      )}
      {(status === 'pending' || status === 'running') && (
        <button onClick={() => cancel(runId)} disabled={isLoading}>
          Cancel
        </button>
      )}
      <button onClick={() => deleteRun(runId)} disabled={isLoading}>
        Delete
      </button>
      {error && <span>{error}</span>}
    </div>
  )
}
```

## Server Handler Setup

On your server, use `createDurablyHandler`:

```ts
// app/lib/durably.server.ts
import { createDurably } from '@coji/durably'
import { createDurablyHandler } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({ dialect }).register({
  syncData: syncDataJob,
})

export const durablyHandler = createDurablyHandler(durably)

await durably.init()

// app/routes/api.durably.$.ts (React Router / Remix)
import { durablyHandler } from '~/lib/durably.server'
import type { Route } from './+types/api.durably.$'

export async function loader({ request }: Route.LoaderArgs) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function action({ request }: Route.ActionArgs) {
  return durablyHandler.handle(request, '/api/durably')
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
  const { isRunning, trigger } = useJob(myJob)

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
