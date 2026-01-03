# CSV Import (Full-Stack)

A complete CSV import system with progress UI, run history, and job management.

**Example code:** [fullstack-react-router](https://github.com/coji/durably/tree/main/examples/fullstack-react-router)

## What You'll Build

- CSV file upload with server-side parsing
- Real-time progress bar via SSE
- Run history dashboard with retry/cancel/delete
- Type-safe client hooks

## Architecture

![Full-Stack Architecture](/images/fullstack-architecture.svg)

## Project Structure

```txt
app/
├── jobs/
│   └── import-csv.ts          # Job definition
├── lib/
│   ├── durably.server.ts      # Durably instance
│   └── durably.client.ts      # Type-safe hooks
├── routes/
│   ├── api.durably.$.ts       # Splat route for all API
│   └── _index.tsx             # UI
```

## Key Code

### Job Definition

Define the import job with validation and import steps. Each step is a checkpoint - if the server crashes, the job resumes from the last completed step.

The job uses `step.progress()` to report real-time progress and `step.log` for structured logging.

```ts
// app/jobs/import-csv.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

const csvRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  amount: z.number(),
})

const outputSchema = z.object({ imported: z.number(), failed: z.number() })

/** Output type for use in components */
export type ImportCsvOutput = z.infer<typeof outputSchema>

export const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({
    filename: z.string(),
    rows: z.array(csvRowSchema),
  }),
  output: outputSchema,
  run: async (step, payload) => {
    step.log.info(`Starting import of ${payload.filename} (${payload.rows.length} rows)`)

    // Step 1: Validate all rows
    const validRows = await step.run('validate', async () => {
      const valid: typeof payload.rows = []
      const invalid: { row: (typeof payload.rows)[0]; reason: string }[] = []

      for (let i = 0; i < payload.rows.length; i++) {
        const row = payload.rows[i]
        step.progress(i + 1, payload.rows.length, `Validating ${row.name}...`)
        await delay(50)

        if (row.amount < 0) {
          invalid.push({ row, reason: `Invalid amount: ${row.amount}` })
          step.log.warn(`Validation failed for ${row.name}: negative amount`)
        } else {
          valid.push(row)
        }
      }

      step.log.info(`Validation complete: ${valid.length} valid, ${invalid.length} invalid`)
      return { valid, invalidCount: invalid.length }
    })

    // Step 2: Import valid rows
    const importResult = await step.run('import', async () => {
      let imported = 0

      for (let i = 0; i < validRows.valid.length; i++) {
        const row = validRows.valid[i]
        step.progress(i + 1, validRows.valid.length, `Importing ${row.name}...`)
        await delay(80)

        // Simulate import
        imported++
        step.log.info(`Imported: ${row.name} (${row.email}) - $${row.amount}`)
      }

      return { imported }
    })

    // Step 3: Finalize
    await step.run('finalize', async () => {
      step.progress(1, 1, 'Finalizing...')
      await delay(200)
      step.log.info('Import finalized')
    })

    return {
      imported: importResult.imported,
      failed: validRows.invalidCount,
    }
  },
})
```

### Server Setup

Create the Durably instance with libsql dialect and register the job. The `createDurablyHandler` provides HTTP/SSE endpoints for the client.

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { importCsvJob } from '~/jobs/import-csv'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

export const durably = createDurably({ dialect }).register({
  importCsv: importCsvJob,
})

export const durablyHandler = createDurablyHandler(durably)

await durably.init()
```

### API Route (Splat)

Use a React Router splat route to expose all Durably endpoints under `/api/durably/*`. This handles trigger, subscribe, and management endpoints.

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

### Type-Safe Client

Create a type-safe client using the server's Durably type. This gives you full TypeScript inference for job inputs and outputs without bundling server code.

```ts
// app/lib/durably.client.ts
import { createDurablyClient } from '@coji/durably-react/client'
import type { durably } from './durably.server'

export const durablyClient = createDurablyClient<typeof durably>({
  api: '/api/durably',
})
```

### Progress UI

Use the `useRun` hook to subscribe to real-time progress via SSE. The hook returns status flags (`isRunning`, `isCompleted`, `isFailed`) and current progress.

```tsx
function ImportProgress({ runId }: { runId: string | null }) {
  const { progress, output, isRunning, isCompleted, isFailed, error } =
    durablyClient.importCsv.useRun(runId)

  if (!runId) return null

  return (
    <div>
      {isRunning && progress && (
        <>
          <progress value={progress.current} max={progress.total} />
          <p>{progress.message}</p>
        </>
      )}
      {isCompleted && (
        <p>Imported {output?.imported}, failed {output?.failed}</p>
      )}
      {isFailed && <p>Error: {error}</p>}
    </div>
  )
}
```

### Dashboard with Actions

Build a dashboard showing all runs with retry, cancel, and delete actions. The `useRuns` hook provides paginated run history, while `useRunActions` provides mutation functions.

```tsx
import { useRuns, useRunActions } from '@coji/durably-react/client'

function Dashboard() {
  const { runs, refresh } = useRuns({ api: '/api/durably' })
  const { retry, cancel, deleteRun } = useRunActions({ api: '/api/durably' })

  return (
    <table>
      {runs.map(run => (
        <tr key={run.id}>
          <td>{run.jobName}</td>
          <td>{run.status}</td>
          <td>
            {run.status === 'failed' && (
              <button onClick={() => { retry(run.id); refresh() }}>
                Retry
              </button>
            )}
            {run.status === 'running' && (
              <button onClick={() => { cancel(run.id); refresh() }}>
                Cancel
              </button>
            )}
          </td>
        </tr>
      ))}
    </table>
  )
}
```

## Resumability

If the server crashes mid-import:

1. Restart the server
2. `durably.init()` picks up the stale run
3. Completed steps return cached results
4. Import continues from the next step

## Next Steps

- [Offline App](/guide/offline-app) — Run in the browser without a server
- [API Reference](/api/durably-react/) — All hooks and options
