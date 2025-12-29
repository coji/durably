# Full-Stack

Run jobs on the server and monitor them from a React frontend. The server handles job execution while the client provides real-time status updates via SSE.

This guide uses [React Router v7](https://reactrouter.com/) as the full-stack framework.

## When to Use

- Web applications with long-running background jobs
- Apps that need reliable server-side execution
- When you want to show job progress in a React UI

## Architecture

```
┌─────────────────┐     HTTP/SSE     ┌─────────────────┐
│  React Client   │ ◄──────────────► │  React Router   │
│  (useJob hooks) │                  │  Server (Durably)│
└─────────────────┘                  └─────────────────┘
```

## Installation

```bash
npm install @coji/durably @coji/durably-react kysely zod @libsql/client @libsql/kysely-libsql
```

## Project Structure

```txt
app/
├── .server/
│   └── durably.ts        # Durably instance and jobs
├── routes/
│   ├── api.durably.trigger.ts   # POST /api/durably/trigger
│   └── api.durably.subscribe.ts # GET /api/durably/subscribe
└── routes/
    └── _index.tsx        # Client component with useJob
```

## Server Setup

### 1. Create Durably Instance

```ts
// app/.server/durably.ts
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

// Initialize on server start
await durably.migrate()
durably.start()
```

### 2. Create API Routes

**Trigger Route:**

```ts
// app/routes/api.durably.trigger.ts
import type { Route } from './+types/api.durably.trigger'
import { handler } from '~/.server/durably'

export async function action({ request }: Route.ActionArgs) {
  return handler.trigger(request)
}
```

**Subscribe Route (SSE):**

```ts
// app/routes/api.durably.subscribe.ts
import type { Route } from './+types/api.durably.subscribe'
import { handler } from '~/.server/durably'

export async function loader({ request }: Route.LoaderArgs) {
  return handler.subscribe(request)
}
```

## Client Setup

### useJob Hook

```tsx
// app/routes/_index.tsx
import { useJob } from '@coji/durably-react/client'

export default function Index() {
  const {
    trigger,
    status,
    output,
    error,
    progress,
    isRunning,
    isCompleted,
    isFailed,
  } = useJob<
    { userId: string },
    { count: number }
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
  const { status, output, error, progress } = useJobRun<{ count: number }>({
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
