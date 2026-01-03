# createDurably

Creates a new Durably instance.

## Signature

```ts
function createDurably(options: DurablyOptions): Durably
```

## Options

```ts
interface DurablyOptions {
  dialect: Dialect
  pollingInterval?: number
  heartbeatInterval?: number
  staleThreshold?: number
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dialect` | `Dialect` | required | Kysely SQLite dialect |
| `pollingInterval` | `number` | `1000` | How often to check for pending jobs (ms) |
| `heartbeatInterval` | `number` | `5000` | How often to update heartbeat (ms) |
| `staleThreshold` | `number` | `30000` | Time until a job is considered stale (ms) |

## Returns

Returns a `Durably` instance with the following methods:

### `init()`

```ts
await durably.init(): Promise<void>
```

Initialize Durably: runs database migrations and starts the worker. This is the recommended way to start Durably. Equivalent to calling `migrate()` then `start()`.

### `migrate()`

```ts
await durably.migrate(): Promise<void>
```

Runs database migrations to create the required tables. Use this when you need to run migrations without starting the worker (e.g., in browser mode where `DurablyProvider` handles starting).

### `start()`

```ts
durably.start(): void
```

Starts the worker that processes pending jobs. Typically called after `migrate()`, or use `init()` for both.

### `stop()`

```ts
await durably.stop(): Promise<void>
```

Stops the worker gracefully, waiting for the current job to complete.

### `register()`

```ts
durably.register<TJobs extends Record<string, JobDefinition>>(
  jobs: TJobs
): { [K in keyof TJobs]: JobHandle }
```

Registers one or more job definitions and returns an object of job handles. Also populates `durably.jobs` with the same handles for type-safe access.

```ts
const { syncUsers, processImage } = durably.register({
  syncUsers: syncUsersJob,
  processImage: processImageJob,
})

// Or access via durably.jobs
await durably.jobs.syncUsers.trigger({ orgId: '123' })
```

See [defineJob](/api/define-job) for details.

### `on()`

```ts
durably.on<E extends EventType>(
  event: E,
  handler: EventHandler<E>
): () => void
```

Subscribes to an event. Returns an unsubscribe function. See [Events](/api/events).

### `retry()`

```ts
await durably.retry(runId: string): Promise<void>
```

Retries a failed or cancelled run by resetting its status to pending.

### `cancel()`

```ts
await durably.cancel(runId: string): Promise<void>
```

Cancels a pending or running run.

### `deleteRun()`

```ts
await durably.deleteRun(runId: string): Promise<void>
```

Deletes a run and its associated steps and logs.

### `getRun()`

```ts
await durably.getRun(runId: string): Promise<Run | null>
```

Gets a single run by ID.

### `getRuns()`

```ts
await durably.getRuns(filter?: RunFilter): Promise<Run[]>

interface RunFilter {
  jobName?: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  limit?: number
  offset?: number
}
```

Gets runs with optional filtering and pagination.

### `getJob()`

```ts
durably.getJob(name: string): JobHandle | undefined
```

Gets a registered job by name.

### `subscribe()`

```ts
durably.subscribe(runId: string): ReadableStream<DurablyEvent>
```

Subscribes to events for a specific run as a ReadableStream. The stream automatically closes when the run completes or fails.

## Example

```ts
import { createDurably } from '@coji/durably'
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({
  dialect,
  pollingInterval: 1000,
  heartbeatInterval: 5000,
  staleThreshold: 30000,
})

// Initialize (migrate + start)
await durably.init()

// Define and register jobs
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const myJobDef = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  run: async (step, payload) => {
    // ...
  },
})

const { myJob } = durably.register({ myJob: myJobDef })

// Or trigger via durably.jobs
await durably.jobs.myJob.trigger({ id: '123' })

// Clean shutdown
process.on('SIGTERM', async () => {
  await durably.stop()
})
```

## createDurablyHandler

Create HTTP handlers for exposing Durably via REST/SSE. Import from `@coji/durably/server`.

```ts
import { createDurablyHandler } from '@coji/durably/server'

const handler = createDurablyHandler(durably, {
  onRequest: async () => {
    await durably.init()
  },
})
```

### Options

```ts
interface CreateDurablyHandlerOptions {
  /** Called before handling each request */
  onRequest?: () => Promise<void> | void
}
```

### handle(request, basePath)

Handle all Durably HTTP requests with automatic routing.

```ts
// React Router / Remix
export async function loader({ request }) {
  return handler.handle(request, '/api/durably')
}

export async function action({ request }) {
  return handler.handle(request, '/api/durably')
}
```

### Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/subscribe?runId=xxx` | SSE stream for run events |
| `GET` | `/runs` | List runs (query: jobName, status, limit, offset) |
| `GET` | `/run?runId=xxx` | Get single run |
| `GET` | `/steps?runId=xxx` | Get steps for a run |
| `GET` | `/runs/subscribe` | SSE stream for run list updates |
| `POST` | `/trigger` | Trigger a job |
| `POST` | `/retry?runId=xxx` | Retry a failed run |
| `POST` | `/cancel?runId=xxx` | Cancel a run |
| `DELETE` | `/run?runId=xxx` | Delete a run |

### Individual Handlers

For custom routing, use individual handlers:

```ts
app.post('/api/durably/trigger', (req) => handler.trigger(req))
app.get('/api/durably/subscribe', (req) => handler.subscribe(req))
app.get('/api/durably/runs', (req) => handler.runs(req))
app.get('/api/durably/run', (req) => handler.run(req))
app.get('/api/durably/steps', (req) => handler.steps(req))
app.post('/api/durably/retry', (req) => handler.retry(req))
app.post('/api/durably/cancel', (req) => handler.cancel(req))
app.delete('/api/durably/run', (req) => handler.delete(req))
app.get('/api/durably/runs/subscribe', (req) => handler.runsSubscribe(req))
```

### Trigger Request Format

```ts
// POST /api/durably/trigger
{
  "jobName": "import-csv",
  "input": { "file": "data.csv" },
  "idempotencyKey": "unique-key",  // optional
  "concurrencyKey": "user-123"      // optional
}

// Response: { "runId": "run_abc123" }
```
