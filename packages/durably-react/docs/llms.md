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

Wraps your app and initializes Durably:

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'

function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
      options={{ pollingInterval: 100 }}
      autoStart={true}
      autoMigrate={true}
    >
      <MyComponent />
    </DurablyProvider>
  )
}
```

**Props:**

- `dialectFactory: () => Dialect` - Factory for Kysely dialect
- `options?: DurablyOptions` - Durably configuration
- `autoStart?: boolean` - Auto-start worker (default: true)
- `autoMigrate?: boolean` - Auto-run migrations (default: true)
- `onReady?: (durably: Durably) => void` - Callback when ready

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
    currentRunId,
    reset,
  } = useJob(myJob, { initialRunId: undefined })

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

**Return type:**

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

On your server, use `createDurablyHandler` from `@coji/durably`:

```ts
import { createDurably, createDurablyHandler, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({ dialect })
const handler = createDurablyHandler(durably)

// Register jobs
const syncJob = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    // Job logic
  },
})
durably.register({ syncJob })

await durably.migrate()
durably.start()

// Express/Hono/etc route handlers
app.post('/api/durably/trigger', async (req) => {
  return handler.trigger(req)
})

app.get('/api/durably/subscribe', (req) => {
  return handler.subscribe(req)
})
```

## Type Definitions

```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed'

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
