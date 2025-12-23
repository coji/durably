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
durably.register<TName, TInput, TOutput>(
  jobDef: JobDefinition<TName, TInput, TOutput>
): JobHandle<TName, TInput, TOutput>
```

Registers a job definition and returns a job handle. See [defineJob](/api/define-job) for details.

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

Retries a failed run by resetting its status to pending.

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

const myJob = durably.register(
  defineJob({
    name: 'my-job',
    input: z.object({ id: z.string() }),
    run: async (step, payload) => {
      // ...
    },
  }),
)

// Clean shutdown
process.on('SIGTERM', async () => {
  await durably.stop()
})
```
