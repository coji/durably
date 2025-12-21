# Node.js

This guide covers using Durably in Node.js environments.

## SQLite Drivers

Durably works with any Kysely-compatible SQLite dialect.

### Turso / libsql (Recommended)

[Turso](https://turso.tech) is a SQLite-compatible database built on [libsql](https://github.com/tursodatabase/libsql). Use local files for development and Turso cloud for production:

```ts
import { LibsqlDialect } from '@libsql/kysely-libsql'

// Local development
const dialect = new LibsqlDialect({
  url: 'file:local.db',
})

// Production (Turso cloud)
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const durably = createDurably({ dialect })
```

Install dependencies:

```bash
npm install @libsql/client @libsql/kysely-libsql
```

### better-sqlite3

[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) is a synchronous SQLite driver:

```ts
import SQLite from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

const database = new SQLite('local.db')
const dialect = new SqliteDialect({ database })

const durably = createDurably({ dialect })
```

## Configuration

```ts
const durably = createDurably({
  dialect,
  pollingInterval: 1000,    // Check for pending jobs every 1s
  heartbeatInterval: 5000,  // Update heartbeat every 5s
  staleThreshold: 30000,    // Mark jobs stale after 30s
})
```

## Lifecycle

```ts
// Run database migrations
await durably.migrate()

// Start the worker
durably.start()

// Trigger jobs
await myJob.trigger({ data: 'value' })

// Stop gracefully
await durably.stop()
```

## Process Signals

Handle graceful shutdown:

```ts
process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await durably.stop()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('Interrupted...')
  await durably.stop()
  process.exit(0)
})
```

## Worker Patterns

### Single Worker

The simplest pattern - one worker per process:

```ts
const durably = createDurably({ dialect })
await durably.migrate()
durably.start()
```

### Multiple Processes

Durably supports multiple workers competing for jobs:

```ts
// worker-1.ts
const durably = createDurably({ dialect })
durably.start()

// worker-2.ts (separate process)
const durably = createDurably({ dialect })
durably.start()
```

Jobs are claimed atomically - only one worker processes each job.

## Error Handling

```ts
durably.on('run:fail', (event) => {
  console.error(`Job ${event.runId} failed:`, event.error)

  // Send to error tracking
  Sentry.captureException(new Error(event.error), {
    extra: { runId: event.runId, jobName: event.jobName },
  })
})
```

## Retrying Failed Jobs

```ts
// Get failed runs
const failedRuns = await durably.getFailedRuns()

// Retry a specific run
await durably.retry(failedRuns[0].id)
```

## Integration with Frameworks

### Express

```ts
import express from 'express'

const app = express()

app.post('/api/trigger-job', async (req, res) => {
  const { id } = req.body
  await myJob.trigger({ id })
  res.json({ status: 'triggered' })
})

// Start both
await durably.migrate()
durably.start()
app.listen(3000)
```

### Fastify

```ts
import Fastify from 'fastify'

const fastify = Fastify()

fastify.post('/api/trigger-job', async (req) => {
  await myJob.trigger(req.body)
  return { status: 'triggered' }
})

await durably.migrate()
durably.start()
await fastify.listen({ port: 3000 })
```
