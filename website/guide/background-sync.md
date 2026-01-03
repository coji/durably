# Background Sync (Server)

Run batch jobs on Node.js without a frontend. Perfect for cron jobs, data pipelines, and CLI tools.

**Example code:** [server-node](https://github.com/coji/durably/tree/main/examples/server-node)

## When to Use

- Scheduled batch processing (cron)
- Data import/export pipelines
- CLI tools with resumable operations
- Microservice background workers

## Installation

```bash
pnpm add @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

## Project Structure

```txt
├── jobs/
│   └── process-image.ts    # Job definition
├── lib/
│   ├── database.ts         # Database dialect
│   └── durably.ts          # Durably instance
└── basic.ts                # Entry point
```

## Setup

### Database

Create a libsql dialect for SQLite persistence. Supports both local files and Turso cloud databases.

```ts
// lib/database.ts
import { LibsqlDialect } from '@libsql/kysely-libsql'

export const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})
```

### Job Definition

Define a job with multiple steps. Each `step.run()` creates a checkpoint - if the process crashes, it resumes from the last completed step.

```ts
// jobs/process-image.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const processImageJob = defineJob({
  name: 'process-image',
  input: z.object({ filename: z.string() }),
  output: z.object({ url: z.string() }),
  run: async (step, payload) => {
    // Step 1: Download
    const data = await step.run('download', async () => {
      await delay(500)
      return { size: 1024000 }
    })

    // Step 2: Resize
    await step.run('resize', async () => {
      await delay(500)
      return { width: 800, height: 600, size: data.size / 2 }
    })

    // Step 3: Upload
    const uploaded = await step.run('upload', async () => {
      await delay(500)
      return { url: `https://cdn.example.com/${payload.filename}` }
    })

    return { url: uploaded.url }
  },
})
```

### Durably Instance

Create the Durably instance and register jobs. The shorter intervals are suitable for development; use longer intervals in production to reduce database load.

```ts
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { processImageJob } from '../jobs/process-image'
import { dialect } from './database'

export const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}).register({
  processImage: processImageJob,
})
```

## Basic Usage

Use `triggerAndWait()` to trigger a job and wait for completion. This blocks until the job finishes and returns the output.

```ts
// basic.ts
import { durably } from './lib/durably'

async function main() {
  await durably.init()

  // Trigger job and wait for completion
  const { id, output } = await durably.jobs.processImage.triggerAndWait({
    filename: 'photo.jpg',
  })
  console.log(`Run ${id} completed`)
  console.log(`Output: ${JSON.stringify(output)}`)

  // Cleanup
  await durably.stop()
  await durably.db.destroy()
}

main().catch(console.error)
```

## Event Monitoring

Subscribe to events to monitor job execution. Useful for logging, metrics, and debugging.

```ts
durably.on('run:start', (event) => {
  console.log(`[run:start] ${event.jobName}`)
})

durably.on('step:complete', (event) => {
  console.log(`[step:complete] ${event.stepName}`)
})

durably.on('run:complete', (event) => {
  console.log(`[run:complete] output=${JSON.stringify(event.output)} duration=${event.duration}ms`)
})

durably.on('run:fail', (event) => {
  console.log(`[run:fail] ${event.error}`)
})
```

## Cron Integration

Combine Durably with node-cron for scheduled job execution. Jobs remain resumable even when triggered by cron.

```ts
// cron-job.ts
import cron from 'node-cron'
import { durably } from './lib/durably'

await durably.init()

// Run every hour
cron.schedule('0 * * * *', async () => {
  await durably.jobs.processImage.trigger({ filename: 'scheduled.jpg' })
})

// Keep process running
```

## CLI with Progress

Build command-line tools with real-time progress output using the `run:progress` event.

```ts
// cli.ts
import { program } from 'commander'
import { durably } from './lib/durably'

program
  .command('process <filename>')
  .action(async (filename) => {
    await durably.init()

    durably.on('run:progress', ({ progress }) => {
      process.stdout.write(`\r${progress.current}/${progress.total} - ${progress.message}`)
    })

    const { output } = await durably.jobs.processImage.triggerAndWait({ filename })
    console.log(`\nDone: ${output.url}`)

    await durably.stop()
  })

program.parse()
```

## Idempotency

Prevent duplicate runs with idempotency keys. If a run with the same key already exists, it returns the existing run instead of creating a new one.

```ts
await durably.jobs.processImage.trigger(
  { filename: 'photo.jpg' },
  { idempotencyKey: `process-${new Date().toISOString().slice(0, 10)}` }
)
// Same key = returns existing run instead of creating new one
```

## Concurrency Control

Limit concurrent jobs with concurrency keys. Only one job with the same key can run at a time - others wait in the queue.

```ts
await durably.jobs.processImage.trigger(
  { filename: 'photo.jpg' },
  { concurrencyKey: 'image-processing' }
)
// Only one job with this key runs at a time
```

## Error Handling & Retry

Durably doesn't auto-retry failures. Use `retry()` to manually retry failed runs, or `cancel()` to stop running jobs.

```ts
// Manual retry on failure
const run = await durably.storage.getRun(runId)
if (run?.status === 'failed') {
  await durably.retry(runId)
}

// Or cancel a running job
if (run?.status === 'running') {
  await durably.cancel(runId)
}
```

## Next Steps

- [CSV Import](/guide/csv-import) — Add a React UI
- [Events Reference](/api/events) — All event types
- [API Reference](/api/create-durably) — Full configuration options
