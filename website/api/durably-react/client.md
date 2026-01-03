# Server-Connected Mode

Connect to a Durably server via HTTP/SSE for real-time job monitoring.

```tsx
import {
  createDurablyClient,
  useJob,
  useJobRun,
  useJobLogs,
  useRuns,
  useRunActions,
} from '@coji/durably-react/client'
```

## createDurablyClient

Create a type-safe client for all registered jobs. This is the recommended way to use server-connected mode.

### Server Setup

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({ dialect }).register({
  importCsv: importCsvJob,
  syncUsers: syncUsersJob,
})

export const durablyHandler = createDurablyHandler(durably)

await durably.migrate()
durably.start()
```

```ts
// app/routes/api.durably.$.ts
import { durablyHandler } from '~/lib/durably.server'
import type { Route } from './+types/api.durably.$'

export async function loader({ request }: Route.LoaderArgs) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function action({ request }: Route.ActionArgs) {
  return durablyHandler.handle(request, '/api/durably')
}
```

### Client Setup

```ts
// app/lib/durably.client.ts
import { createDurablyClient } from '@coji/durably-react/client'
import type { durably } from './durably.server'

export const durablyClient = createDurablyClient<typeof durably>({
  api: '/api/durably',
})
```

### Usage

```tsx
// Fully type-safe!
function CsvImporter() {
  const { trigger, status, output, isRunning } = durablyClient.importCsv.useJob()

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

---

## useJob

Direct hook for triggering jobs when not using `createDurablyClient`.

```tsx
import { useJob } from '@coji/durably-react/client'

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
    isCompleted,
    currentRunId,
    reset,
  } = useJob<
    { userId: string },  // Input type
    { count: number }    // Output type
  >({
    api: '/api/durably',
    jobName: 'sync-data',
    initialRunId: undefined,  // Optional: resume existing run
  })

  const handleClick = async () => {
    const { runId } = await trigger({ userId: 'user_123' })
    console.log('Started:', runId)
  }

  return <button onClick={handleClick}>Sync</button>
}
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `api` | `string` | API base path (e.g., `/api/durably`) |
| `jobName` | `string` | Name of the job to trigger |
| `initialRunId` | `string` | Resume subscription to an existing run |

---

## useJobRun

Subscribe to an existing run via SSE.

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

### Options

| Option | Type | Description |
|--------|------|-------------|
| `api` | `string` | API base path |
| `runId` | `string` | The run ID to subscribe to |

---

## useJobLogs

Subscribe to logs from a run via SSE.

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

### Options

| Option | Type | Description |
|--------|------|-------------|
| `api` | `string` | API base path |
| `runId` | `string` | The run ID to subscribe to |
| `maxLogs` | `number` | Maximum number of logs to keep |

---

## useRuns

List and paginate job runs with real-time updates on the first page.

The first page (page 0) automatically subscribes to SSE for real-time updates. It listens to:
- `run:trigger`, `run:start`, `run:complete`, `run:fail`, `run:cancel`, `run:retry` - refresh list
- `run:progress` - update progress in place
- `step:start`, `step:complete`, `step:fail` - refresh for step updates

Other pages are static and require manual refresh.

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
    goToPage,
    refresh,
  } = useRuns({
    api: '/api/durably',
    jobName: 'sync-data',  // Optional filter
    status: 'completed',   // Optional filter
    pageSize: 10,
  })

  return (
    <div>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            {run.jobName}: {run.status}
            {run.progress && ` (${run.progress.current}/${run.progress.total})`}
          </li>
        ))}
      </ul>
      <div>
        <button onClick={prevPage} disabled={page === 0}>Prev</button>
        <span>Page {page + 1}</span>
        <button onClick={nextPage} disabled={!hasMore}>Next</button>
        <button onClick={refresh}>Refresh</button>
      </div>
    </div>
  )
}
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `api` | `string` | API base path |
| `jobName` | `string` | Filter by job name |
| `status` | `RunStatus` | Filter by status |
| `pageSize` | `number` | Number of runs per page |

### Return Type

| Property | Type | Description |
|----------|------|-------------|
| `runs` | `RunRecord[]` | List of runs |
| `isLoading` | `boolean` | Loading state |
| `error` | `string \| null` | Error message |
| `page` | `number` | Current page (0-indexed) |
| `hasMore` | `boolean` | Whether more pages exist |
| `nextPage` | `() => void` | Go to next page |
| `prevPage` | `() => void` | Go to previous page |
| `goToPage` | `(page: number) => void` | Go to specific page |
| `refresh` | `() => void` | Refresh current page |

---

## useRunActions

Perform actions on runs (retry, cancel, delete).

```tsx
import { useRunActions } from '@coji/durably-react/client'

function RunActions({ runId, status }: { runId: string; status: string }) {
  const {
    retry,
    cancel,
    deleteRun,
    getRun,
    getSteps,
    isLoading,
    error,
  } = useRunActions({ api: '/api/durably' })

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
      {(status === 'completed' || status === 'failed' || status === 'cancelled') && (
        <button onClick={() => deleteRun(runId)} disabled={isLoading}>
          Delete
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  )
}
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `api` | `string` | API base path |

### Return Type

| Property | Type | Description |
|----------|------|-------------|
| `retry` | `(runId: string) => Promise<void>` | Retry a failed run |
| `cancel` | `(runId: string) => Promise<void>` | Cancel a running job |
| `deleteRun` | `(runId: string) => Promise<void>` | Delete a run |
| `getRun` | `(runId: string) => Promise<RunRecord>` | Get run details |
| `getSteps` | `(runId: string) => Promise<StepRecord[]>` | Get step details |
| `isLoading` | `boolean` | Loading state |
| `error` | `string \| null` | Error message |
