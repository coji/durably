# Durably - LLM Documentation

> Step-oriented resumable batch execution for Node.js and browsers using SQLite.

## Overview

Durably is a minimal workflow engine that persists step results to SQLite. If a job is interrupted (server restart, browser tab close, crash), it automatically resumes from the last successful step.

## Installation

```bash
# Node.js with libsql (recommended)
pnpm add @coji/durably kysely zod @libsql/client @libsql/kysely-libsql

# Browser with SQLocal
pnpm add @coji/durably kysely zod sqlocal
```

## Core Concepts

### 1. Durably Instance

```ts
import { createDurably } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({
  dialect,
  pollingInterval: 1000, // Job polling interval (ms)
  heartbeatInterval: 5000, // Heartbeat update interval (ms)
  staleThreshold: 30000, // When to consider a job abandoned (ms)
})
```

### 2. Job Definition

```ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const syncUsersJob = defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
  run: async (step, payload) => {
    // Step 1: Fetch users (result is persisted)
    const users = await step.run('fetch-users', async () => {
      return await api.fetchUsers(payload.orgId)
    })

    // Step 2: Save to database
    await step.run('save-to-db', async () => {
      await db.upsertUsers(users)
    })

    return { syncedCount: users.length }
  },
})

// Register jobs with durably instance
const { syncUsers } = durably.register({
  syncUsers: syncUsersJob,
})
```

### 3. Starting the Worker

```ts
// Initialize: runs migrations and starts the worker
await durably.init()

// Or separately if needed:
// await durably.migrate()  // Run migrations only
// durably.start()          // Start worker only
```

### 4. Triggering Jobs

```ts
// Basic trigger (fire and forget)
const run = await syncUsers.trigger({ orgId: 'org_123' })
console.log(run.id, run.status) // "pending"

// Wait for completion
const result = await syncUsers.triggerAndWait(
  { orgId: 'org_123' },
  { timeout: 5000 },
)
console.log(result.output.syncedCount)

// With idempotency key (prevents duplicate jobs)
await syncUsers.trigger(
  { orgId: 'org_123' },
  { idempotencyKey: 'webhook-event-456' },
)

// With concurrency key (serializes execution)
await syncUsers.trigger({ orgId: 'org_123' }, { concurrencyKey: 'org_123' })
```

## Step Context API

The `step` object provides these methods:

### step.run(name, fn)

Executes a step and persists its result. On resume, returns cached result without re-executing.

```ts
const result = await step.run('step-name', async () => {
  return await someAsyncOperation()
})
```

### step.progress(current, total?, message?)

Updates progress information for the run.

```ts
step.progress(50, 100, 'Processing items...')
```

### step.log

Structured logging within jobs.

```ts
step.log.info('Starting process', { userId: '123' })
step.log.warn('Rate limit approaching')
step.log.error('Failed to connect', { error: err.message })
```

## Run Management

### Get Run Status

```ts
// Via job handle (type-safe output)
const run = await syncUsers.getRun(runId)
if (run?.status === 'completed') {
  console.log(run.output.syncedCount)
}

// Via durably instance (cross-job)
const run = await durably.getRun(runId)
```

### Query Runs

```ts
// Get failed runs
const failedRuns = await durably.getRuns({ status: 'failed' })

// Filter by job name with pagination
const runs = await durably.getRuns({
  jobName: 'sync-users',
  status: 'completed',
  limit: 10,
  offset: 0,
})
```

### Retry Failed Runs

```ts
await durably.retry(runId)
```

### Cancel Runs

```ts
await durably.cancel(runId)
```

### Delete Runs

```ts
await durably.deleteRun(runId)
```

## Events

Subscribe to job execution events:

```ts
// Run lifecycle events
durably.on('run:trigger', (e) => console.log('Triggered:', e.runId))
durably.on('run:start', (e) => console.log('Started:', e.runId))
durably.on('run:complete', (e) => console.log('Done:', e.output))
durably.on('run:fail', (e) => console.error('Failed:', e.error))
durably.on('run:cancel', (e) => console.log('Cancelled:', e.runId))
durably.on('run:retry', (e) => console.log('Retried:', e.runId))
durably.on('run:progress', (e) =>
  console.log('Progress:', e.progress.current, '/', e.progress.total),
)

// Step events
durably.on('step:start', (e) => console.log('Step:', e.stepName))
durably.on('step:complete', (e) => console.log('Step done:', e.stepName))
durably.on('step:fail', (e) => console.error('Step failed:', e.stepName))

// Log events
durably.on('log:write', (e) => console.log(`[${e.level}]`, e.message))
```

## Advanced APIs

### getJob

Get a registered job by name:

```ts
const job = durably.getJob('sync-users')
if (job) {
  const run = await job.trigger({ orgId: 'org_123' })
}
```

### subscribe

Subscribe to events for a specific run as a ReadableStream:

```ts
const stream = durably.subscribe(runId)
const reader = stream.getReader()

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  switch (value.type) {
    case 'run:start':
      console.log('Started')
      break
    case 'run:complete':
      console.log('Completed:', value.output)
      break
    case 'run:fail':
      console.error('Failed:', value.error)
      break
    case 'run:progress':
      console.log('Progress:', value.progress)
      break
    case 'log:write':
      console.log(`[${value.level}]`, value.message)
      break
  }
}
```

### createDurablyHandler

Create HTTP handlers for client/server architecture using Web Standard Request/Response:

```ts
import { createDurablyHandler } from '@coji/durably'

const handler = createDurablyHandler(durably)

// Use the unified handle() method with automatic routing
app.all('/api/durably/*', async (req) => {
  return await handler.handle(req, '/api/durably')
})

// Or use individual endpoints
app.post('/api/durably/trigger', (req) => handler.trigger(req))
app.get('/api/durably/subscribe', (req) => handler.subscribe(req))
app.get('/api/durably/runs', (req) => handler.runs(req))
app.get('/api/durably/run', (req) => handler.run(req))
app.get('/api/durably/steps', (req) => handler.steps(req))
app.get('/api/durably/runs/subscribe', (req) => handler.runsSubscribe(req))
app.post('/api/durably/retry', (req) => handler.retry(req))
app.post('/api/durably/cancel', (req) => handler.cancel(req))
app.delete('/api/durably/run', (req) => handler.delete(req))
```

**Handler Interface:**

```ts
interface DurablyHandler {
  // Unified routing handler
  handle(request: Request, basePath: string): Promise<Response>

  // Individual endpoints
  trigger(request: Request): Promise<Response> // POST /trigger
  subscribe(request: Request): Response // GET /subscribe?runId=xxx (SSE)
  runs(request: Request): Promise<Response> // GET /runs
  run(request: Request): Promise<Response> // GET /run?runId=xxx
  steps(request: Request): Promise<Response> // GET /steps?runId=xxx
  runsSubscribe(request: Request): Response // GET /runs/subscribe (SSE)
  retry(request: Request): Promise<Response> // POST /retry?runId=xxx
  cancel(request: Request): Promise<Response> // POST /cancel?runId=xxx
  delete(request: Request): Promise<Response> // DELETE /run?runId=xxx
}

interface TriggerRequest {
  jobName: string
  input: Record<string, unknown>
  idempotencyKey?: string
  concurrencyKey?: string
}

interface TriggerResponse {
  runId: string
}
```

## Plugins

### Log Persistence

```ts
import { withLogPersistence } from '@coji/durably'

durably.use(withLogPersistence())
```

## Browser Usage

```ts
import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

const { dialect } = new SQLocalKysely('app.sqlite3')

const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})

// Same API as Node.js
const { myJob } = durably.register({
  myJob: defineJob({
    name: 'my-job',
    input: z.object({}),
    run: async (step) => {
      /* ... */
    },
  }),
})

// Initialize (same as Node.js)
await durably.init()
```

## Run Lifecycle

```text
trigger() → pending → running → completed
                  ↘           ↗
                    → failed
```

- **pending**: Waiting for worker to pick up
- **running**: Worker is executing steps
- **completed**: All steps finished successfully
- **failed**: A step threw an error
- **cancelled**: Manually cancelled via `cancel()`

## Resumability

When a job resumes after interruption:

1. Worker polls for pending/stale runs
2. Job function is re-executed from the beginning
3. `step.run()` checks SQLite for cached results
4. Completed steps return cached values immediately (no re-execution)
5. Execution continues from the first incomplete step

## Type Definitions

```ts
interface JobDefinition<TName, TInput, TOutput> {
  name: TName
  input: ZodType<TInput>
  output?: ZodType<TOutput>
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
}

interface StepContext {
  runId: string
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>
  progress(current: number, total?: number, message?: string): void
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

interface Run<TOutput = unknown> {
  id: string
  jobName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  payload: unknown
  output?: TOutput
  error?: string
  progress?: { current: number; total?: number; message?: string }
  createdAt: string
  updatedAt: string
}

interface JobHandle<TName, TInput, TOutput> {
  name: TName
  trigger(input: TInput, options?: TriggerOptions): Promise<Run<TOutput>>
  triggerAndWait(
    input: TInput,
    options?: TriggerOptions,
  ): Promise<{ id: string; output: TOutput }>
  batchTrigger(inputs: BatchTriggerInput<TInput>[]): Promise<Run<TOutput>[]>
  getRun(id: string): Promise<Run<TOutput> | null>
  getRuns(filter?: RunFilter): Promise<Run<TOutput>[]>
}

interface TriggerOptions {
  idempotencyKey?: string
  concurrencyKey?: string
  timeout?: number
}
```

## License

MIT
