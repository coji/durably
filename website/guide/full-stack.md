# Full-Stack

Run jobs on the server and monitor them from a React frontend. The server handles job execution while the client provides real-time status updates via SSE.

This guide uses [React Router v7](https://reactrouter.com/) as the full-stack framework.

## When to Use

- Web applications with long-running background jobs
- Apps that need reliable server-side execution
- When you want to show job progress in a React UI

## Architecture

```txt
┌─────────────────┐     HTTP/SSE     ┌─────────────────┐
│  React Client   │ ◄──────────────► │  React Router   │
│  (durably hooks)│                  │  Server (Durably)│
└─────────────────┘                  └─────────────────┘
```

## Installation

```bash
npm install @coji/durably @coji/durably-react kysely zod @libsql/client @libsql/kysely-libsql
```

## Project Structure

```txt
app/
├── lib/
│   ├── durably.server.ts # Durably instance and jobs (server-only)
│   └── durably.client.ts # Type-safe client hooks (client-only)
├── routes/
│   ├── api.durably.trigger.ts   # POST /api/durably/trigger
│   ├── api.durably.subscribe.ts # GET /api/durably/subscribe
│   └── _index.tsx        # Upload form with action
```

## Setup

### 1. Server (`durably.server.ts`)

```ts
// app/lib/durably.server.ts
import { createDurably, defineJob } from '@coji/durably'
import { createDurablyHandler } from '@coji/durably/server'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({ dialect })
export const handler = createDurablyHandler(durably)

// Define jobs
const importCsvJob = defineJob({
  name: 'importCsv',
  input: z.object({ rows: z.array(z.record(z.string())) }),
  output: z.object({ imported: z.number(), skipped: z.number() }),
  run: async (step, payload) => {
    let imported = 0
    let skipped = 0

    for (let i = 0; i < payload.rows.length; i++) {
      await step.run(`import-row-${i}`, async () => {
        try {
          await db.insert('users', payload.rows[i])
          imported++
        } catch {
          skipped++
        }
      })
      step.progress(i + 1, payload.rows.length)
    }

    return { imported, skipped }
  },
})

// Register jobs
export const jobs = durably.register({
  importCsv: importCsvJob,
  // Add more jobs here:
  // syncUsers: syncUsersJob,
})

// Initialize on server start
await durably.migrate()
durably.start()
```

### 2. Client (`durably.client.ts`)

Create a type-safe client once, import the jobs type using `import type`:

```ts
// app/lib/durably.client.ts
import { createDurablyClient } from '@coji/durably-react/client'
import type { jobs } from '~/lib/durably.server'

export const durably = createDurablyClient<typeof jobs>({
  api: '/api/durably',
})
```

### 3. API Routes

**Trigger Route:**

```ts
// app/routes/api.durably.trigger.ts
import type { Route } from './+types/api.durably.trigger'
import { handler } from '~/lib/durably.server'

export async function action({ request }: Route.ActionArgs) {
  return handler.trigger(request)
}
```

**Subscribe Route (SSE):**

```ts
// app/routes/api.durably.subscribe.ts
import type { Route } from './+types/api.durably.subscribe'
import { handler } from '~/lib/durably.server'

export async function loader({ request }: Route.LoaderArgs) {
  return handler.subscribe(request)
}
```

## Usage

### Server-Side Trigger (Form with action)

```tsx
// app/routes/_index.tsx
import { Form } from 'react-router'
import type { Route } from './+types/_index'
import { jobs } from '~/lib/durably.server'
import { durably } from '~/lib/durably.client'

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',')
  return lines.slice(1).map((line) => {
    const values = line.split(',')
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]))
  })
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const file = formData.get('file') as File
  const text = await file.text()
  const rows = parseCSV(text)

  const { runId } = await jobs.importCsv.trigger({ rows })
  return { runId }
}

export default function CsvImporter({ actionData }: Route.ComponentProps) {
  const { progress, output, error, isRunning, isCompleted, isFailed } =
    durably.importCsv.useRun(actionData?.runId ?? null)

  return (
    <div>
      <Form method="post" encType="multipart/form-data">
        <input type="file" name="file" accept=".csv" disabled={isRunning} />
        <button type="submit" disabled={isRunning}>
          {isRunning ? 'Importing...' : 'Import CSV'}
        </button>
      </Form>

      {progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <p>{progress.current} / {progress.total} rows</p>
        </div>
      )}

      {isCompleted && (
        <p>Done! Imported {output?.imported}, skipped {output?.skipped}</p>
      )}
      {isFailed && <p>Error: {error}</p>}
    </div>
  )
}
```

### Client-Side Trigger

For cases where you trigger from the client:

```tsx
import { durably } from '~/lib/durably.client'

function SimpleImporter() {
  const { trigger, progress, isRunning, isCompleted, output } =
    durably.importCsv.useJob()

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const rows = parseCSV(text)
    trigger({ rows }) // Fully type-safe with autocomplete!
  }

  return (
    <div>
      <input type="file" accept=".csv" onChange={handleFileChange} />
      {isRunning && <p>Progress: {progress?.current}/{progress?.total}</p>}
      {isCompleted && <p>Imported {output?.imported} rows</p>}
    </div>
  )
}
```

### Subscribe to Logs

```tsx
import { durably } from '~/lib/durably.client'

function ImportLogs({ runId }: { runId: string }) {
  const { logs, clearLogs } = durably.importCsv.useLogs(runId, { maxLogs: 100 })

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

## API Reference

| Function                             | Description                          |
| ------------------------------------ | ------------------------------------ |
| `createDurablyClient<typeof jobs>()` | Create type-safe client for all jobs |
| `durably.jobName.useJob()`           | Trigger and monitor a job            |
| `durably.jobName.useRun(runId)`      | Subscribe to an existing run         |
| `durably.jobName.useLogs(runId)`     | Subscribe to logs from a run         |

See the [API Reference](/api/durably-react#server-connected-mode) for detailed documentation.
