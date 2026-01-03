# React Hooks

React bindings for Durably - hooks for triggering and monitoring jobs with real-time updates.

## Requirements

- **React 19+** (uses `React.use()` for Promise resolution)

## Which Mode Should I Use?

Durably React provides two modes for different architectures:

| Question | Browser Hooks | Server Hooks |
|----------|---------------|--------------|
| Where do jobs run? | In the browser | On the server |
| Where is data stored? | Browser OPFS | Server database |
| Works offline? | Yes | No |
| Share state across tabs/users? | No | Yes |
| Needs backend? | No | Yes |

### Choose Browser Hooks when:

- Building **offline-capable** or **local-first** apps
- Data should stay on the user's device
- Prototyping without a backend
- Single-user, single-tab usage

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react'
```

[Browser Hooks Reference →](./browser)

### Choose Server Hooks when:

- Building **full-stack** applications
- Jobs need server resources (databases, APIs, secrets)
- Multiple users or tabs need to see the same state
- Need persistent storage across devices

```tsx
import { createDurablyClient } from '@coji/durably-react/client'
```

[Server Hooks Reference →](./client)

## Installation

```bash
# Browser mode - runs Durably in the browser
pnpm add @coji/durably @coji/durably-react kysely zod sqlocal

# Server mode - connects to Durably server
pnpm add @coji/durably-react
```

## Quick Examples

### Browser Mode

Jobs run entirely in the browser with OPFS persistence.

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react'
import { durably } from './lib/durably'
import { importCsvJob } from './jobs/import-csv'

function App() {
  return (
    <DurablyProvider durably={durably} fallback={<p>Loading...</p>}>
      <ImportButton />
    </DurablyProvider>
  )
}

function ImportButton() {
  const { trigger, progress, isRunning, isCompleted, output } = useJob(importCsvJob)

  return (
    <div>
      <button onClick={() => trigger({ filename: 'data.csv' })} disabled={isRunning}>
        Import
      </button>
      {progress && <p>{progress.current}/{progress.total}</p>}
      {isCompleted && <p>Done: {output?.count} rows</p>}
    </div>
  )
}
```

### Server Mode

Jobs run on the server, with real-time updates via SSE.

```tsx
// 1. Create type-safe client (client-side file)
import { createDurablyClient } from '@coji/durably-react/client'
import type { durably } from './durably.server'

export const durablyClient = createDurablyClient<typeof durably>({
  api: '/api/durably',
})

// 2. Use in components
function ImportButton() {
  const { trigger, progress, isRunning, isCompleted, output } =
    durablyClient.importCsv.useJob()

  return (
    <div>
      <button onClick={() => trigger({ filename: 'data.csv' })} disabled={isRunning}>
        Import
      </button>
      {progress && <p>{progress.current}/{progress.total}</p>}
      {isCompleted && <p>Done: {output?.count} rows</p>}
    </div>
  )
}
```

## Available Hooks

### Both Modes

| Hook | Description |
|------|-------------|
| `useJob` | Trigger and monitor a job |
| `useJobRun` | Subscribe to an existing run by ID |
| `useJobLogs` | Subscribe to logs from a run |
| `useRuns` | List runs with filtering and pagination |

### Browser Mode Only

| Hook | Description |
|------|-------------|
| `useDurably` | Access the Durably instance directly |

### Server Mode Only

| Hook | Description |
|------|-------------|
| `useRunActions` | Retry, cancel, delete runs |

## Common Patterns

### Show Progress Bar

```tsx
function ProgressBar({ runId }: { runId: string }) {
  const { progress, isRunning } = useJobRun({ runId })

  if (!isRunning || !progress) return null

  const percent = Math.round((progress.current / progress.total) * 100)

  return (
    <div>
      <progress value={progress.current} max={progress.total} />
      <span>{percent}% - {progress.message}</span>
    </div>
  )
}
```

### Handle Errors

```tsx
function JobRunner() {
  const { trigger, isFailed, error, reset } = useJob(myJob)

  if (isFailed) {
    return (
      <div>
        <p>Error: {error}</p>
        <button onClick={reset}>Try Again</button>
      </div>
    )
  }

  return <button onClick={() => trigger({ ... })}>Run</button>
}
```

### Run Dashboard (Server Mode)

```tsx
function Dashboard() {
  const { runs, page, hasMore, nextPage, prevPage } = useRuns({
    api: '/api/durably',
    pageSize: 10,
  })
  const { retry, cancel, deleteRun } = useRunActions({ api: '/api/durably' })

  return (
    <table>
      <thead>
        <tr><th>Job</th><th>Status</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {runs.map(run => (
          <tr key={run.id}>
            <td>{run.jobName}</td>
            <td>{run.status}</td>
            <td>
              {run.status === 'failed' && <button onClick={() => retry(run.id)}>Retry</button>}
              {run.status === 'running' && <button onClick={() => cancel(run.id)}>Cancel</button>}
              <button onClick={() => deleteRun(run.id)}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

## Type Definitions

See [Type Definitions](./types) for all exported types.
