# Fullstack Mode

Server-side jobs with a React UI. Real-time progress via SSE, type-safe hooks, run dashboard with retry/cancel/delete.

**Example code:** [fullstack-react-router](https://github.com/coji/durably/tree/main/examples/fullstack-react-router)

## When to Use

- Web apps that need background job processing
- Real-time progress UI (file imports, data sync, etc.)
- Multi-user apps where jobs and state are shared
- Admin dashboards for job management

## Install

```bash
pnpm add @coji/durably @coji/durably-react kysely zod @libsql/client @libsql/kysely-libsql
```

## Architecture

```
Browser                          Server
┌──────────────┐   HTTP/SSE    ┌──────────────────┐
│ React App    │ ←──────────── │ Durably           │
│              │               │ ├── Worker        │
│ createDurably│ ──trigger──→  │ ├── Jobs          │
│ (proxy)      │ ←──SSE─────  │ └── SQLite        │
└──────────────┘               └──────────────────┘
```

The client sends HTTP requests to trigger jobs and subscribes to SSE for real-time updates. All job execution happens on the server.

## Project Structure

```txt
app/
├── jobs/
│   └── import-csv.ts          # Job definition
├── lib/
│   ├── durably.server.ts      # Server: Durably instance + handler
│   └── durably.ts             # Client: type-safe hooks
└── routes/
    ├── api.durably.$.ts       # API route (splat)
    └── _index.tsx             # UI
```

## Step 1: Define a Job

```ts
// app/jobs/import-csv.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({
    filename: z.string(),
    rows: z.array(z.object({ name: z.string(), email: z.string() })),
  }),
  output: z.object({ imported: z.number() }),
  run: async (step, input) => {
    step.log.info(`Starting import of ${input.filename}`)

    const validRows = await step.run('validate', async () => {
      step.progress(1, 3, 'Validating...')
      return input.rows.filter((row) => row.email.includes('@'))
    })

    await step.run('import', async () => {
      for (let i = 0; i < validRows.length; i++) {
        step.progress(
          i + 1,
          validRows.length,
          `Importing ${validRows[i].name}...`,
        )
        // await db.insert('users', validRows[i])
      }
    })

    return { imported: validRows.length }
  },
})
```

## Step 2: Server Setup

Create the Durably instance and HTTP handler. `createDurablyHandler` exposes trigger, subscribe, and management endpoints.

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { importCsvJob } from '~/jobs/import-csv'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({
  dialect,
  jobs: { importCsv: importCsvJob },
})

export const durablyHandler = createDurablyHandler(durably)

await durably.init()
```

## Step 3: API Route

A single splat route handles all Durably endpoints:

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

::: tip Other frameworks
Works with Next.js, Hono, Express, etc. See [HTTP Handler](/api/http-handler#framework-integration) for examples.
:::

## Step 4: Type-Safe Client

Create a client using the server's type. This gives you autocomplete for job names and full type inference for inputs/outputs — without bundling any server code.

```ts
// app/lib/durably.ts
import { createDurably } from '@coji/durably-react'
import type { durably } from './durably.server'

export const durablyClient = createDurably<typeof durably>({
  api: '/api/durably',
})
```

Now `durablyClient.importCsv` has typed hooks: `.useJob()`, `.useRun()`, `.useLogs()`.

## Step 5: Build the UI

### Trigger + Progress

```tsx
// app/routes/_index.tsx
import { Form } from 'react-router'
import { durably } from '~/lib/durably.server'
import { durablyClient } from '~/lib/durably'
import type { Route } from './+types/_index'

// Server action: trigger job on form submit
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const file = formData.get('file') as File
  const text = await file.text()
  const rows = text
    .split('\n')
    .slice(1)
    .map((line) => {
      const [name, email] = line.split(',')
      return { name, email }
    })
  const run = await durably.jobs.importCsv.trigger({
    filename: file.name,
    rows,
  })
  return { runId: run.id }
}

// Client component: subscribe to real-time progress
export default function Home({ actionData }: Route.ComponentProps) {
  const { progress, output, isRunning, isCompleted, isFailed, error } =
    durablyClient.importCsv.useRun(actionData?.runId ?? null)

  return (
    <div>
      <Form method="post" encType="multipart/form-data">
        <input type="file" name="file" accept=".csv" />
        <button disabled={isRunning}>
          {isRunning ? 'Importing...' : 'Import CSV'}
        </button>
      </Form>

      {isRunning && progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <p>{progress.message}</p>
        </div>
      )}
      {isCompleted && <p>Done! Imported {output?.imported} rows.</p>}
      {isFailed && <p>Error: {error}</p>}
    </div>
  )
}
```

### Dashboard with Run History

Use the built-in cross-job hooks for a dashboard:

```tsx
import { durablyClient } from '~/lib/durably'

function Dashboard() {
  const { runs, hasMore, nextPage } = durablyClient.useRuns({ pageSize: 10 })
  const { retry, cancel, deleteRun } = durablyClient.useRunActions()

  return (
    <table>
      <thead>
        <tr>
          <th>Job</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <td>{run.jobName}</td>
            <td>{run.status}</td>
            <td>
              {run.status === 'failed' && (
                <button onClick={() => retry(run.id)}>Retry</button>
              )}
              {run.status === 'running' && (
                <button onClick={() => cancel(run.id)}>Cancel</button>
              )}
              <button onClick={() => deleteRun(run.id)}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
      {hasMore && <button onClick={nextPage}>Load More</button>}
    </table>
  )
}
```

The first page automatically subscribes to SSE for real-time updates — new runs appear instantly.

## How It Works

1. **`trigger()`** on the server creates a run in `pending` state
2. The Durably worker picks it up and starts executing steps
3. The client subscribes via SSE and receives `run:progress`, `step:complete`, etc.
4. React hooks update state automatically — no polling needed
5. If the server restarts, the worker resumes from the last completed step

## Resumability

Stop the server mid-import and restart — it picks up right where it left off:

1. `durably.init()` detects the stale run (heartbeat expired)
2. Resets it to `pending`
3. Worker re-executes; completed steps return cached results
4. Import continues from the next incomplete step

## Next Steps

- **[SPA Mode](/guide/spa-mode)** — Run entirely in the browser without a server
- **[Authentication](/guide/auth)** — Protect your endpoints
- **[API Reference](/api/durably-react/fullstack)** — All fullstack hooks and options
