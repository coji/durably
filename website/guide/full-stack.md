# Full-Stack

Run jobs on the server and monitor them from a React frontend. The server handles job execution while the client provides real-time status updates via SSE.

## When to Use

- Web applications with long-running background jobs
- Apps that need reliable server-side execution
- When you want to show job progress in a React UI

## Architecture

```
┌─────────────────┐     HTTP/SSE     ┌─────────────────┐
│  React Client   │ ◄──────────────► │  Node.js Server │
│  (useJob hooks) │                  │  (Durably)      │
└─────────────────┘                  └─────────────────┘
```

## Installation

**Client:**

```bash
npm install @coji/durably-react
```

**Server:**

```bash
npm install @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

## Server Setup

### 1. Create Durably Instance

```ts
// server/durably.ts
import { createDurably, createDurablyHandler, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({ dialect })
export const handler = createDurablyHandler(durably)

// Define and register jobs
export const syncJob = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    const users = await step.run('fetch-users', async () => {
      return await api.fetchUsers(payload.userId)
    })

    await step.run('save-to-db', async () => {
      await db.saveUsers(users)
    })

    return { count: users.length }
  },
})

durably.register(syncJob)
```

### 2. Create API Routes

**Express:**

```ts
import express from 'express'
import { durably, handler } from './durably'

const app = express()
app.use(express.json())

// Trigger a job
app.post('/api/durably/trigger', async (req, res) => {
  const result = await handler.trigger(req)
  res.json(result)
})

// Subscribe to job events (SSE)
app.get('/api/durably/subscribe', (req, res) => {
  return handler.subscribe(req, res)
})

// Start server and worker
await durably.migrate()
durably.start()
app.listen(3000)
```

**Hono:**

```ts
import { Hono } from 'hono'
import { durably, handler } from './durably'

const app = new Hono()

app.post('/api/durably/trigger', async (c) => {
  const result = await handler.trigger(c.req.raw)
  return c.json(result)
})

app.get('/api/durably/subscribe', (c) => {
  return handler.subscribe(c.req.raw)
})

await durably.migrate()
durably.start()
export default app
```

## Client Setup

### useJob Hook

```tsx
import { useJob } from '@coji/durably-react/client'

function SyncButton() {
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
    isFailed,
    currentRunId,
    reset,
  } = useJob<
    { userId: string }, // Input type
    { count: number }   // Output type
  >({
    api: '/api/durably',
    jobName: 'sync-data',
  })

  return (
    <div>
      <button
        onClick={() => trigger({ userId: 'user_123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Syncing...' : 'Sync Data'}
      </button>

      {progress && (
        <p>Progress: {progress.current}/{progress.total}</p>
      )}

      {isCompleted && <p>Synced {output?.count} items</p>}
      {isFailed && <p>Error: {error}</p>}
    </div>
  )
}
```

### useJobRun Hook

Subscribe to an existing run by ID:

```tsx
import { useJobRun } from '@coji/durably-react/client'

function RunMonitor({ runId }: { runId: string }) {
  const { status, output, error, progress, logs } = useJobRun<{ count: number }>({
    api: '/api/durably',
    runId,
  })

  return (
    <div>
      <p>Status: {status}</p>
      {output && <p>Result: {output.count} items</p>}
    </div>
  )
}
```

### useJobLogs Hook

Subscribe to logs from a run:

```tsx
import { useJobLogs } from '@coji/durably-react/client'

function LogViewer({ runId }: { runId: string }) {
  const { logs, clearLogs } = useJobLogs({
    api: '/api/durably',
    runId,
    maxLogs: 100,
  })

  return (
    <div>
      <button onClick={clearLogs}>Clear</button>
      <ul>
        {logs.map((log) => (
          <li key={log.id}>
            [{log.level}] {log.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

## Available Hooks

| Hook | Description |
|------|-------------|
| `useJob` | Trigger and monitor a job with real-time status, progress, and logs |
| `useJobRun` | Subscribe to an existing run by ID |
| `useJobLogs` | Subscribe to logs from a run with optional limit |

See the [API Reference](/api/durably-react#server-connected-mode) for detailed documentation.
