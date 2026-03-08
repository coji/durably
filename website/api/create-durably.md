# createDurably

Creates a new Durably instance.

## Signature

```ts
// Without jobs (use .register() later)
function createDurably<TLabels>(
  options: DurablyOptions<TLabels>,
): Durably<{}, TLabels>

// With jobs (1-step initialization)
function createDurably<TLabels, TJobs>(
  options: DurablyOptions<TLabels, TJobs> & { jobs: TJobs },
): Durably<TransformToHandles<TJobs, TLabels>, TLabels>
```

## Options

```ts
interface DurablyOptions<
  TLabels extends Record<string, string> = Record<string, string>,
  TJobs extends Record<string, JobDefinition> = Record<string, never>,
> {
  dialect: Dialect
  pollingIntervalMs?: number
  leaseRenewIntervalMs?: number
  leaseMs?: number
  preserveSteps?: boolean
  labels?: z.ZodType<TLabels>
  jobs?: TJobs
}
```

| Option                 | Type        | Default  | Description                                                                           |
| ---------------------- | ----------- | -------- | ------------------------------------------------------------------------------------- |
| `dialect`              | `Dialect`   | required | Kysely dialect (SQLite, libSQL, or PostgreSQL)                                        |
| `pollingIntervalMs`    | `number`    | `1000`   | How often to check for pending jobs (ms)                                              |
| `leaseRenewIntervalMs` | `number`    | `5000`   | How often to renew the lease (ms)                                                     |
| `leaseMs`              | `number`    | `30000`  | Lease duration — time until a job is considered stale (ms)                            |
| `labels`               | `z.ZodType` | —        | Zod schema for labels. Enables type-safe labels and runtime validation on `trigger()` |
| `preserveSteps`        | `boolean`   | `false`  | Keep step output data when runs reach terminal state (completed/failed/cancelled)     |
| `jobs`                 | `TJobs`     | —        | Job definitions to register. Shorthand for calling `.register()` after creation       |

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

Runs database migrations to create the required tables. Use `init()` instead for most cases.

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

::: tip
You can also pass `jobs` directly to `createDurably()` as a shorthand:

```ts
const durably = createDurably({
  dialect,
  jobs: { syncUsers: syncUsersJob, processImage: processImageJob },
})
```

:::

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

### `retrigger()`

```ts
await durably.retrigger(runId: string): Promise<Run>
```

Retriggers a failed or cancelled run by creating a fresh run with the same input, options, and labels. Returns the new `Run` object. Throws if the original input doesn't match the current job's input schema.

### `cancel()`

```ts
await durably.cancel(runId: string): Promise<void>
```

Cancels a pending or leased run.

### `deleteRun()`

```ts
await durably.deleteRun(runId: string): Promise<void>
```

Deletes a run and its associated steps and logs.

### `getRun()`

```ts
await durably.getRun<T extends Run<TLabels> = Run<TLabels>>(runId: string): Promise<T | null>
```

Gets a single run by ID. Supports generic type parameter for type-safe access.

```ts
// Untyped (returns Run)
const run = await durably.getRun(runId)

// Typed (returns custom type)
type MyRun = Run & {
  input: { userId: string }
  output: { count: number } | null
}
const typedRun = await durably.getRun<MyRun>(runId)
```

### `getRuns()`

```ts
await durably.getRuns<T extends Run<TLabels> = Run<TLabels>>(filter?: RunFilter<TLabels>): Promise<T[]>

interface RunFilter<TLabels extends Record<string, string> = Record<string, string>> {
  jobName?: string | string[]  // single or multiple job names
  status?: 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'
  labels?: Partial<TLabels>    // filter by labels (all specified must match)
  limit?: number
  offset?: number
}
```

Gets runs with optional filtering and pagination. Supports generic type parameter.

```ts
// Filter by multiple job names
const runs = await durably.getRuns({
  jobName: ['sync-users', 'import-data'],
  status: 'completed',
})

// Typed getRuns
type MyRun = Run & {
  input: { userId: string }
  output: { count: number } | null
}
const runs = await durably.getRuns<MyRun>({ jobName: 'my-job' })
```

### `Run` Type

The `Run` object returned by `getRun()` and `getRuns()`:

```ts
interface Run<TLabels extends Record<string, string> = Record<string, string>> {
  id: string
  jobName: string
  input: unknown
  status: 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'
  idempotencyKey: string | null
  concurrencyKey: string | null
  currentStepIndex: number
  stepCount: number
  progress: { current: number; total?: number; message?: string } | null
  output: unknown | null
  error: string | null
  labels: TLabels
  leaseOwner: string | null
  leaseExpiresAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}
```

| Field              | Type                                                              | Description                                                     |
| ------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `id`               | `string`                                                          | Unique run ID                                                   |
| `jobName`          | `string`                                                          | Name of the job                                                 |
| `input`            | `unknown`                                                         | Input payload passed to the job                                 |
| `status`           | `'pending' \| 'leased' \| 'completed' \| 'failed' \| 'cancelled'` | Current run status                                              |
| `idempotencyKey`   | `string \| null`                                                  | Deduplication key                                               |
| `concurrencyKey`   | `string \| null`                                                  | Concurrency group key                                           |
| `currentStepIndex` | `number`                                                          | Index of the current step being executed                        |
| `stepCount`        | `number`                                                          | Total number of completed steps                                 |
| `progress`         | `{ current: number; total?: number; message?: string } \| null`   | Latest progress report                                          |
| `output`           | `unknown \| null`                                                 | Return value of the job (when completed)                        |
| `error`            | `string \| null`                                                  | Error message (when failed)                                     |
| `labels`           | `TLabels` (defaults to `Record<string, string>`)                  | Key/value labels for filtering (type-safe when schema provided) |
| `leaseOwner`       | `string \| null`                                                  | Worker ID that holds the lease (`null` when not leased)         |
| `leaseExpiresAt`   | `string \| null`                                                  | ISO timestamp when the lease expires (`null` when not leased)   |
| `startedAt`        | `string \| null`                                                  | ISO timestamp when the run started                              |
| `completedAt`      | `string \| null`                                                  | ISO timestamp when the run completed or failed                  |
| `createdAt`        | `string`                                                          | ISO timestamp when the run was created                          |
| `updatedAt`        | `string`                                                          | ISO timestamp of the last update                                |

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
  pollingIntervalMs: 1000,
  leaseRenewIntervalMs: 5000,
  leaseMs: 30000,
})

// Initialize (migrate + start)
await durably.init()

// Define and register jobs
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const myJobDef = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  run: async (step, input) => {
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

## See Also

- [HTTP Handler](/api/http-handler) — Expose Durably via HTTP/SSE for React clients
- [defineJob](/api/define-job) — Define jobs with typed schemas
- [Events](/api/events) — Subscribe to run and step events
