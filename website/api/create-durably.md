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

### `migrate()`

```ts
await durably.migrate(): Promise<void>
```

Runs database migrations to create the required tables.

### `start()`

```ts
durably.start(): void
```

Starts the worker that processes pending jobs.

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

await durably.migrate()
durably.start()

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
