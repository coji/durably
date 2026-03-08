# Core Concepts

Four things to understand: **Jobs**, **Steps**, **Runs**, and **Resumability**.

## Jobs

A job is a function with a name and typed input/output. Define it once, run it anywhere.

```ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const importJob = defineJob({
  name: 'import-csv',
  input: z.object({ filename: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, input) => {
    // ... steps go here
    return { count: 42 }
  },
})
```

Register jobs when creating the Durably instance:

```ts
const durably = createDurably({
  dialect,
  jobs: { importCsv: importJob },
})
```

The key in `jobs` (e.g. `importCsv`) becomes the accessor: `durably.jobs.importCsv.trigger(...)`.

## Steps

Steps are checkpoints inside a job. Each `step.run()` persists its return value to SQLite.

```ts
run: async (step, input) => {
  const data = await step.run('fetch', () => fetchData())
  const result = await step.run('process', () => transform(data))
  return result
}
```

**First execution:** runs the function, saves the result.
**After restart:** returns the cached result instantly, skips the function.

### Step Names Must Be Unique

Each step needs a unique name within a job run. Duplicate names return the cached result of the first one.

```ts
// Good: unique names
await step.run('fetch-users', () => fetchUsers())
await step.run('fetch-orders', () => fetchOrders())

// Bad: same name returns cached result of first call
await step.run('fetch', () => fetchUsers())
await step.run('fetch', () => fetchOrders()) // Returns users, not orders!
```

### Keep Steps Small

One big step = lose everything on crash. Many small steps = resume from the last checkpoint.

```ts
// Bad: crash loses all progress
await step.run('import-all', async () => {
  for (const row of rows) await db.insert(row)
})

// Good: checkpoint per batch
for (let i = 0; i < rows.length; i += 100) {
  await step.run(`batch-${i}`, async () => {
    for (const row of rows.slice(i, i + 100)) {
      await db.insert(row)
    }
  })
}
```

### Progress & Logging

Report progress and write structured logs from inside steps:

```ts
await step.run('import', async () => {
  for (let i = 0; i < rows.length; i++) {
    await db.insert(rows[i])
    step.progress(i + 1, rows.length, `Importing row ${i + 1}...`)
    step.log.info(`Imported: ${rows[i].name}`)
  }
})
```

## Runs

A run is one execution of a job. Trigger a run, and it goes through this lifecycle:

```
pending → leased → completed
                  → failed
                  → cancelled
```

```ts
// Trigger: creates a run in "pending" state
const { id } = await durably.jobs.importCsv.trigger({ filename: 'data.csv' })

// The worker picks it up → "leased"
// Steps execute one by one
// On success → "completed" with output
// On error → "failed" with error message
```

### Trigger Options

```ts
await durably.jobs.importCsv.trigger(
  { filename: 'data.csv' },
  {
    // Prevent duplicates: same key = same run
    idempotencyKey: 'import-2024-01-01',

    // Only one job per key runs at a time
    concurrencyKey: 'csv-imports',

    // Metadata for filtering and multi-tenancy
    labels: { organizationId: 'org_123' },
  },
)
```

## Resumability

This is Durably's core feature. Here's exactly how it works:

1. Each `step.run()` saves its result to SQLite
2. Leased jobs renew their lease to prove they're alive
3. If a job's lease expires (crash, tab close, restart), it's marked **stale**
4. The worker picks it up again as **pending**
5. On re-execution, completed steps return cached results
6. Execution continues from the next incomplete step

```ts
// First run
const data = await step.run('fetch', () => api.fetch()) // Runs, saves result
await step.run('process', () => process(data)) // Crashes here!

// After restart — same job resumes
const data = await step.run('fetch', () => api.fetch()) // Returns cached result
await step.run('process', () => process(data)) // Runs fresh
```

### Lease Configuration

```ts
createDurably({
  dialect,
  leaseRenewIntervalMs: 5000, // Renew lease every 5s (default)
  leaseMs: 30000, // Lease duration — stale after 30s without renewal (default)
})
```

### Design for Idempotency

Steps may re-execute on failure boundaries. Design for safe retries:

```ts
// Good: upsert instead of insert
await step.run('save', () => db.upsert(user))

// Good: idempotency key with external APIs
await step.run('charge', () =>
  stripe.charges.create({
    amount: 1000,
    idempotency_key: `order_${orderId}`,
  }),
)
```

## Events

Monitor everything with the event system:

```ts
durably.on('run:leased', ({ runId, jobName }) =>
  console.log(`Leased: ${jobName}`),
)
durably.on('run:complete', ({ runId, output }) => console.log('Done:', output))
durably.on('run:fail', ({ runId, error }) => console.log('Failed:', error))
durably.on('run:progress', ({ progress }) =>
  console.log(`${progress.current}/${progress.total}`),
)
```

See [Events API](/api/events) for the full list.

## Next Steps

- **[Server Mode](/guide/server-mode)** — Batch processing, cron, CLI tools
- **[Fullstack Mode](/guide/fullstack-mode)** — React UI with real-time progress
- **[SPA Mode](/guide/spa-mode)** — Run entirely in the browser
