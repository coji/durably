# @coji/durably-react

React bindings for [Durably](https://github.com/coji/durably) - step-oriented resumable batch execution.

**[Documentation](https://coji.github.io/durably/)** | **[GitHub](https://github.com/coji/durably)**

## Features

- React hooks for triggering and monitoring Durably jobs
- Real-time status updates, progress, and logs
- Type-safe with full TypeScript support
- Two operation modes:
  - **Browser-complete mode**: Run Durably entirely in the browser with OPFS
  - **Server-connected mode**: Connect to a remote Durably server via SSE

## Installation

```bash
# Browser-complete mode (with SQLocal)
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (client only)
npm install @coji/durably-react
```

## Browser-Complete Mode

Run Durably entirely in the browser using SQLite WASM with OPFS backend.

### Setup

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'

function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
    >
      <MyComponent />
    </DurablyProvider>
  )
}
```

### useJob Hook

Trigger and monitor a job's execution:

```tsx
import { defineJob } from '@coji/durably'
import { useJob } from '@coji/durably-react'
import { z } from 'zod'

const syncJob = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    const data = await step.run('fetch', () => api.fetch(payload.userId))
    await step.run('save', () => db.save(data))
    return { count: data.length }
  },
})

function SyncButton() {
  const { trigger, status, output, error, progress, isRunning, isCompleted } =
    useJob(syncJob)

  return (
    <div>
      <button
        onClick={() => trigger({ userId: 'user_123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Syncing...' : 'Sync Data'}
      </button>

      {progress && (
        <p>
          Progress: {progress.current}/{progress.total}
        </p>
      )}

      {isCompleted && <p>Synced {output?.count} items</p>}
      {error && <p>Error: {error}</p>}
    </div>
  )
}
```

### useJobRun Hook

Subscribe to an existing run by ID:

```tsx
import { useJobRun } from '@coji/durably-react'

function RunStatus({ runId }: { runId: string }) {
  const { status, output, error, progress } = useJobRun({ runId })

  return (
    <div>
      <p>Status: {status}</p>
      {progress && <p>Progress: {progress.message}</p>}
    </div>
  )
}
```

### useJobLogs Hook

Subscribe to logs from a run:

```tsx
import { useJobLogs } from '@coji/durably-react'

function LogViewer({ runId }: { runId: string }) {
  const { logs, clearLogs } = useJobLogs({ runId, maxLogs: 100 })

  return (
    <div>
      <button onClick={clearLogs}>Clear</button>
      {logs.map((log) => (
        <div key={log.id}>
          [{log.level}] {log.message}
        </div>
      ))}
    </div>
  )
}
```

## Server-Connected Mode

Connect to a Durably server via HTTP/SSE. No `@coji/durably` dependency needed on the client.

### Client Setup

```tsx
import { useJob, useJobRun, useJobLogs } from '@coji/durably-react/client'

function SyncButton() {
  const { trigger, status, output } = useJob<
    { userId: string },
    { count: number }
  >({
    api: '/api/durably',
    jobName: 'sync-data',
  })

  return <button onClick={() => trigger({ userId: 'user_123' })}>Sync</button>
}
```

### Server Setup

On your server, use `createDurablyHandler` to expose the API:

```ts
// server.ts
import { createDurably, createDurablyHandler, defineJob } from '@coji/durably'

const durably = createDurably({ dialect })
const handler = createDurablyHandler(durably)

// Register jobs
durably.register({ syncJob })

// Route handlers
app.post('/api/durably/trigger', (req) => handler.trigger(req))
app.get('/api/durably/subscribe', (req) => handler.subscribe(req))
```

## API Reference

### DurablyProvider

| Prop             | Type             | Default  | Description                   |
| ---------------- | ---------------- | -------- | ----------------------------- |
| `dialectFactory` | `() => Dialect`  | required | Factory for Kysely dialect    |
| `options`        | `DurablyOptions` | -        | Durably configuration options |
| `autoStart`      | `boolean`        | `true`   | Auto-start the worker         |
| `autoMigrate`    | `boolean`        | `true`   | Auto-run migrations           |

### useJob (Browser Mode)

```ts
const result = useJob(jobDefinition, options?)
```

**Returns:**

- `isReady`: Whether Durably is initialized
- `trigger(input)`: Trigger job, returns `{ runId }`
- `triggerAndWait(input)`: Trigger and wait for completion
- `status`: `'pending' | 'running' | 'completed' | 'failed' | null`
- `output`: Job output (when completed)
- `error`: Error message (when failed)
- `progress`: `{ current, total?, message? }`
- `logs`: Array of log entries
- `isRunning`, `isPending`, `isCompleted`, `isFailed`: Boolean helpers
- `currentRunId`: Current run ID
- `reset()`: Reset all state

### useJob (Client Mode)

```ts
const result = useJob<TInput, TOutput>({ api, jobName })
```

Same return type as browser mode.

### useJobRun

```ts
const result = useJobRun({ runId }) // Browser mode
const result = useJobRun({ api, runId }) // Client mode
```

**Returns:** Same as `useJob` except no `trigger` functions.

### useJobLogs

```ts
const result = useJobLogs({ runId, maxLogs? })  // Browser mode
const result = useJobLogs({ api, runId, maxLogs? })  // Client mode
```

**Returns:**

- `isReady`: Whether ready
- `logs`: Array of log entries
- `clearLogs()`: Clear collected logs

## License

MIT
