# Server Mode

Run batch jobs on Node.js without a frontend. Perfect for cron jobs, data pipelines, and CLI tools.

**Example code:** [server-node](https://github.com/coji/durably/tree/main/examples/server-node)

## When to Use

- Scheduled batch processing (cron)
- Data import/export pipelines
- CLI tools with resumable operations
- Microservice background workers

## Install

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
└── main.ts                 # Entry point
```

## Setup

### Database

```ts
// lib/database.ts
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

export const dialect = new LibsqlDialect({ client })
```

### Job Definition

```ts
// jobs/process-image.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const processImageJob = defineJob({
  name: 'process-image',
  input: z.object({ filename: z.string() }),
  output: z.object({ url: z.string() }),
  run: async (step, input) => {
    const data = await step.run('download', async () => {
      step.progress(1, 3, 'Downloading...')
      await delay(500)
      return { size: 1024000 }
    })

    await step.run('resize', async () => {
      step.progress(2, 3, 'Resizing...')
      await delay(500)
      return { width: 800, height: 600, size: data.size / 2 }
    })

    const uploaded = await step.run('upload', async () => {
      step.progress(3, 3, 'Uploading...')
      await delay(500)
      return { url: `https://cdn.example.com/${input.filename}` }
    })

    return { url: uploaded.url }
  },
})
```

### Durably Instance

```ts
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { processImageJob } from '../jobs/process-image'
import { dialect } from './database'

export const durably = createDurably({
  dialect,
  jobs: { processImage: processImageJob },
})
```

## Basic Usage

`triggerAndWait()` queues a job and blocks until it finishes:

```ts
// main.ts
import { durably } from './lib/durably'

await durably.init()

const { id, output } = await durably.jobs.processImage.triggerAndWait({
  filename: 'photo.jpg',
})
console.log(`Run ${id}: ${output.url}`)

await durably.stop()
await durably.db.destroy()
```

## Event Monitoring

Subscribe to events for logging, metrics, or debugging:

```ts
durably.on('run:leased', (e) => console.log(`[leased] ${e.jobName}`))
durably.on('step:complete', (e) => console.log(`[step] ${e.stepName}`))
durably.on('run:complete', (e) =>
  console.log(`[done] ${JSON.stringify(e.output)}`),
)
durably.on('run:fail', (e) => console.log(`[fail] ${e.error}`))
```

## Cron Integration

Combine with node-cron for scheduled execution:

```ts
import cron from 'node-cron'
import { durably } from './lib/durably'

await durably.init()

// Run every hour
cron.schedule('0 * * * *', async () => {
  await durably.jobs.processImage.trigger({ filename: 'scheduled.jpg' })
})
```

## CLI with Progress

Build CLI tools with real-time progress:

```ts
import { program } from 'commander'
import { durably } from './lib/durably'

program.command('process <filename>').action(async (filename) => {
  await durably.init()

  durably.on('run:progress', ({ progress }) => {
    process.stdout.write(
      `\r${progress.current}/${progress.total} - ${progress.message}`,
    )
  })

  const { output } = await durably.jobs.processImage.triggerAndWait({
    filename,
  })
  console.log(`\nDone: ${output.url}`)

  await durably.stop()
})

program.parse()
```

## Idempotency & Concurrency

```ts
// Prevent duplicate runs
await durably.jobs.processImage.trigger(
  { filename: 'photo.jpg' },
  { idempotencyKey: `process-${new Date().toISOString().slice(0, 10)}` },
)

// Only one job with this key runs at a time
await durably.jobs.processImage.trigger(
  { filename: 'photo.jpg' },
  { concurrencyKey: 'image-processing' },
)
```

## Error Handling

Durably doesn't auto-retry. Check status and retrigger manually:

```ts
const run = await durably.getRun(runId)

if (run?.status === 'failed') {
  const newRun = await durably.retrigger(runId) // Creates a fresh run
  console.log(`New run: ${newRun.id}`)
}

if (run?.status === 'leased') {
  await durably.cancel(runId)
}
```

See [Error Handling & Retrigger](/guide/error-handling) for more patterns.

## Next Steps

- **[Fullstack Mode](/guide/fullstack-mode)** — Add a React UI with real-time progress
- **[SPA Mode](/guide/spa-mode)** — Run entirely in the browser
- **[Events Reference](/api/events)** — All event types
