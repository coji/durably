# React

This guide covers using Durably in React applications.

The `@coji/durably-react` package provides React hooks for triggering and monitoring Durably jobs.

## Installation

```bash
# Browser-complete mode (run Durably entirely in the browser)
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (connect to a Durably server)
npm install @coji/durably-react
```

### Browser-Complete Mode

Run Durably entirely in the browser using SQLite WASM with OPFS backend.

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react'
import { defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Define job outside component
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

function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
    >
      <SyncButton />
    </DurablyProvider>
  )
}
```

### Server-Connected Mode

Connect to a Durably server via HTTP/SSE. No `@coji/durably` dependency needed on the client.

```tsx
import { useJob } from '@coji/durably-react/client'

function SyncButton() {
  const { trigger, status, output } = useJob<
    { userId: string },
    { count: number }
  >({
    api: '/api/durably',
    jobName: 'sync-data',
  })

  return (
    <button onClick={() => trigger({ userId: 'user_123' })}>Sync</button>
  )
}
```

### Available Hooks

| Hook | Description |
|------|-------------|
| `useJob` | Trigger and monitor a job with real-time status, progress, and logs |
| `useJobRun` | Subscribe to an existing run by ID |
| `useJobLogs` | Subscribe to logs from a run with optional limit |
| `useDurably` | Access the Durably instance directly (browser mode only) |

See the [API Reference](/api/durably-react) for detailed documentation.
