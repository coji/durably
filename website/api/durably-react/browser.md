# Browser-Complete Mode

Run Durably entirely in the browser using SQLite WASM with OPFS persistence.

```tsx
import { DurablyProvider, useDurably, useJob, useJobRun, useJobLogs, useRuns } from '@coji/durably-react'
```

## DurablyProvider

Wraps your app and initializes Durably with a browser SQLite database.

```tsx
import { DurablyProvider } from '@coji/durably-react'
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

const sqlocal = new SQLocalKysely('app.sqlite3')

const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingInterval: 100,
}).register({
  myJob: myJobDef,
})

await durably.migrate()

function App() {
  return (
    <DurablyProvider durably={durably} fallback={<p>Loading...</p>}>
      <MyComponent />
    </DurablyProvider>
  )
}
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `durably` | `Durably \| Promise<Durably>` | required | Durably instance or Promise |
| `autoStart` | `boolean` | `true` | Auto-start worker on mount |
| `onReady` | `(durably: Durably) => void` | - | Callback when ready |
| `fallback` | `ReactNode` | - | Loading fallback (wraps in Suspense) |

---

## useDurably

Access the Durably instance directly.

```tsx
import { useDurably } from '@coji/durably-react'

function Component() {
  const { durably, isReady, error } = useDurably()

  if (!isReady) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>

  // Use durably instance directly
  const runs = await durably.storage.getRuns()
}
```

### Return Type

| Property | Type | Description |
|----------|------|-------------|
| `durably` | `Durably \| null` | The Durably instance |
| `isReady` | `boolean` | Whether Durably is initialized |
| `error` | `Error \| null` | Initialization error |

---

## useJob

Trigger and monitor a job. Pass a `JobDefinition` to get type-safe input/output.

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
  } = useJob(myJob)

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

### Options

| Option | Type | Description |
|--------|------|-------------|
| `initialRunId` | `string` | Resume subscription to an existing run |

### Return Type

```ts
interface UseJobResult<TInput, TOutput> {
  isReady: boolean
  trigger: (input: TInput) => Promise<{ runId: string }>
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  status: RunStatus | null
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

---

## useJobRun

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

### Options

| Option | Type | Description |
|--------|------|-------------|
| `runId` | `string \| null` | The run ID to subscribe to |

---

## useJobLogs

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

### Options

| Option | Type | Description |
|--------|------|-------------|
| `runId` | `string \| null` | The run ID to subscribe to |
| `maxLogs` | `number` | Maximum number of logs to keep |

---

## useRuns

List runs with optional filtering.

```tsx
import { useRuns } from '@coji/durably-react'

function RunList() {
  const { runs, isLoading } = useRuns({
    jobName: 'my-job',
    status: 'completed',
    limit: 10,
  })

  return (
    <ul>
      {runs.map(run => (
        <li key={run.id}>{run.status}</li>
      ))}
    </ul>
  )
}
```

### Options

| Option | Type | Description |
|--------|------|-------------|
| `jobName` | `string` | Filter by job name |
| `status` | `RunStatus` | Filter by status |
| `limit` | `number` | Maximum number of runs to return |
