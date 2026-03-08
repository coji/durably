# Quick Reference

A one-page overview of the Durably API. Use this as a cheat sheet or starting point.

## Installation

```bash
# Core package
pnpm add @coji/durably kysely zod

# React bindings (optional)
pnpm add @coji/durably-react

# SQLite driver (choose one)
pnpm add @libsql/client @libsql/kysely-libsql  # Server (libSQL/Turso)
pnpm add sqlocal                                # Browser (OPFS)
```

## Define a Job

Jobs are the core unit of work. Each job has a name, input schema, and a run function.

```ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({ filename: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, input) => {
    // Step 1: Parse file (cached on resume)
    const rows = await step.run('parse', async () => {
      return parseCSV(input.filename)
    })

    // Step 2: Import each row
    for (const [i, row] of rows.entries()) {
      await step.run(`import-${i}`, () => db.insert(row))
      step.progress(i + 1, rows.length, `Importing row ${i + 1}`)
    }

    step.log.info('Import complete', { count: rows.length })
    return { count: rows.length }
  },
})
```

**See:** [defineJob](/api/define-job) | [Step Context](/api/step)

## Create Instance

Create a Durably instance with a SQLite dialect and register jobs.

```ts
import { createDurably } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({
  dialect,
  pollingIntervalMs: 1000, // Check for jobs every 1s
  leaseRenewIntervalMs: 5000, // Lease renewal every 5s
  leaseMs: 30000, // Lease duration (stale after 30s)
  // labels: z.object({ ... }),  // Optional: type-safe labels
  jobs: { importCsv: importCsvJob },
})

await durably.init() // Migrate DB + start worker
```

**See:** [createDurably](/api/create-durably)

## Trigger Jobs

```ts
// Fire and forget
const run = await durably.jobs.importCsv.trigger({ filename: 'data.csv' })
console.log('Started:', run.id)

// Wait for completion
const { id, output } = await durably.jobs.importCsv.triggerAndWait({
  filename: 'data.csv',
})
console.log('Done:', output.count)

// With options
await durably.jobs.importCsv.trigger(
  { filename: 'data.csv' },
  {
    idempotencyKey: 'import-2024-01-01', // Prevent duplicates
    concurrencyKey: 'csv-imports', // Limit concurrency
    labels: { organizationId: 'org_123' }, // For filtering
  },
)
```

## Monitor Events

```ts
durably.on('run:leased', (e) => console.log(`Leased: ${e.jobName}`))
durably.on('run:complete', (e) => console.log(`Done in ${e.duration}ms`))
durably.on('run:fail', (e) => console.error(`Failed: ${e.error}`))
durably.on('run:progress', (e) =>
  console.log(`${e.progress.current}/${e.progress.total}`),
)
```

**See:** [Events](/api/events)

## Server Integration

Expose Durably via HTTP/SSE for React clients.

```ts
import { createDurablyHandler } from '@coji/durably'

const handler = createDurablyHandler(durably)

// React Router / Remix
export async function loader({ request }) {
  return handler.handle(request, '/api/durably')
}

export async function action({ request }) {
  return handler.handle(request, '/api/durably')
}
```

**See:** [HTTP Handler](/api/http-handler)

## React Hooks

### Fullstack Mode

Connect to a Durably server via HTTP/SSE.

```tsx
// 1. Create type-safe hooks
import { createDurably } from '@coji/durably-react'
import type { durably } from './durably.server'

const durably = createDurably<typeof durably>({
  api: '/api/durably',
})

// 2. Use in components
function ImportButton() {
  const { trigger, progress, isLeased, isCompleted, output } =
    durably.importCsv.useJob()

  return (
    <div>
      <button
        onClick={() => trigger({ filename: 'data.csv' })}
        disabled={isLeased}
      >
        Import
      </button>
      {progress && (
        <p>
          {progress.current}/{progress.total}
        </p>
      )}
      {isCompleted && <p>Imported {output?.count} rows</p>}
    </div>
  )
}
```

### SPA Mode (Offline)

Run Durably entirely in the browser with OPFS persistence.

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react/spa'
import { durably } from './durably'
import { importCsvJob } from './jobs'

function App() {
  return (
    <DurablyProvider durably={durably} fallback={<p>Loading...</p>}>
      <ImportButton />
    </DurablyProvider>
  )
}

function ImportButton() {
  const { trigger, progress, isLeased } = useJob(importCsvJob)
  // ...
}
```

**See:** [React Hooks Overview](/api/durably-react/) | [SPA Hooks](/api/durably-react/spa) | [Fullstack Hooks](/api/durably-react/fullstack)

## API at a Glance

### Core (@coji/durably)

| Export                          | Description                         |
| ------------------------------- | ----------------------------------- |
| `createDurably(options)`        | Create instance with SQLite dialect |
| `defineJob(config)`             | Define a job with typed schema      |
| `createDurablyHandler(durably)` | Create HTTP/SSE handler             |

### Instance Methods

| Method               | Description                            |
| -------------------- | -------------------------------------- |
| `init()`             | Migrate database and start worker      |
| `register(jobs)`     | Register job definitions               |
| `on(event, handler)` | Subscribe to events                    |
| `stop()`             | Stop worker gracefully                 |
| `retrigger(runId)`   | Retrigger failed run (creates new run) |
| `cancel(runId)`      | Cancel leased job                      |

### Step Context

| Method                                 | Description                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `step.run(name, fn)`                   | Create resumable checkpoint. `fn` receives an `AbortSignal` for cooperative cancellation. |
| `step.progress(current, total?, msg?)` | Report progress                                                                           |
| `step.log.info/warn/error(msg)`        | Write structured logs                                                                     |

### React Hooks (@coji/durably-react)

| Hook            | Mode      | Description                    |
| --------------- | --------- | ------------------------------ |
| `useJob`        | Both      | Trigger and monitor jobs       |
| `useJobRun`     | Both      | Subscribe to existing run      |
| `useRuns`       | Both      | List runs with pagination      |
| `useRunActions` | Fullstack | Retrigger, cancel, delete runs |
| `useDurably`    | SPA       | Access Durably instance        |

## Type Exports

```ts
import type {
  AuthConfig,
  ClientRun,
  Durably,
  DurablyOptions,
  DurablyHandler,
  CreateDurablyHandlerOptions,
  JobDefinition,
  JobHandle,
  StepContext,
  Run,
  RunFilter,
  RunOperation,
  RunsSubscribeFilter,
  RunStatus,
  TriggerOptions,
  TriggerAndWaitOptions,
  TriggerRequest,
  TriggerResponse,
  ProgressData,
  LogData,
  DurablyEvent,
  EventType,
} from '@coji/durably'
import { createDurablyHandler, toClientRun } from '@coji/durably'
```

### `Run` Type

Key fields on the `Run` object returned by `getRun()` and `getRuns()`:

| Field            | Type                                                              | Description                                                     |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `id`             | `string`                                                          | Unique run ID                                                   |
| `jobName`        | `string`                                                          | Name of the job                                                 |
| `input`          | `unknown`                                                         | Input payload passed to the job                                 |
| `status`         | `'pending' \| 'leased' \| 'completed' \| 'failed' \| 'cancelled'` | Current run status                                              |
| `output`         | `unknown \| null`                                                 | Return value of the job (when completed)                        |
| `error`          | `string \| null`                                                  | Error message (when failed)                                     |
| `progress`       | `{ current: number; total?: number; message?: string } \| null`   | Latest progress report                                          |
| `labels`         | `TLabels` (defaults to `Record<string, string>`)                  | Key/value labels for filtering (type-safe when schema provided) |
| `leaseOwner`     | `string \| null`                                                  | Worker ID that holds the lease (`null` when not leased)         |
| `leaseExpiresAt` | `string \| null`                                                  | ISO timestamp when the lease expires (`null` when not leased)   |
| `startedAt`      | `string \| null`                                                  | ISO timestamp when the run started                              |
| `completedAt`    | `string \| null`                                                  | ISO timestamp when the run completed or failed                  |
| `createdAt`      | `string`                                                          | ISO timestamp when the run was created                          |
| `updatedAt`      | `string`                                                          | ISO timestamp of the last update                                |

HTTP endpoints (`/runs`, `/run`) return `ClientRun` — the same fields minus `leaseOwner`, `idempotencyKey`, `concurrencyKey`, `leaseExpiresAt`, and `updatedAt`. Use `toClientRun(run)` to apply the same projection in custom code.

**See:** [createDurably - Run Type](/api/create-durably#run-type) for the full field list.
