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
import { z } from 'zod'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

// Option 1: With jobs (1-step initialization, returns typed instance)
const durably = createDurably({
  dialect,
  pollingInterval: 1000, // Job polling interval (ms)
  leaseInterval: 5000, // Lease renewal interval (ms)
  staleThreshold: 30000, // When to consider a lease expired (ms)
  preserveSteps: true, // Keep step output data on terminal state (default: true)
  // Optional: type-safe labels with Zod schema
  // labels: z.object({ organizationId: z.string(), env: z.string() }),
  jobs: {
    syncUsers: syncUsersJob,
  },
})
// durably.jobs.syncUsers is immediately available and type-safe

// Option 2: Without jobs (register later)
const durably = createDurably({ dialect })
const { syncUsers } = durably.register({
  syncUsers: syncUsersJob,
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
  run: async (step, input) => {
    // Step 1: Fetch users (result is persisted)
    const users = await step.run('fetch-users', async () => {
      return await api.fetchUsers(input.orgId)
    })

    // Step 2: Save to database
    await step.run('save-to-db', async () => {
      await db.upsertUsers(users)
    })

    return { syncedCount: users.length }
  },
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

// With labels (for filtering)
await syncUsers.trigger({ orgId: 'org_123' }, { labels: { source: 'browser' } })

// Labels for multi-tenancy
await syncUsers.trigger(
  { orgId: 'org_123' },
  { labels: { organizationId: 'org_123', env: 'prod' } },
)
```

## Step Context API

The `step` object provides these methods:

### step.run(name, fn)

Executes a step and persists its result. On resume, returns cached result without re-executing. The callback receives an `AbortSignal` that is aborted when the run is cancelled, enabling cooperative cancellation of long-running steps.

```ts
const result = await step.run('step-name', async (signal) => {
  return await someAsyncOperation({ signal })
})
```

### step.progress(current, total?, message?)

Updates progress information for the run. Call freely in loops — SSE delivery is throttled by `sseThrottleMs` (default 100ms) so clients receive smooth updates without flooding.

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

// Via durably instance (untyped)
const run = await durably.getRun(runId)

// Via durably instance (typed with generic parameter)
type MyRun = Run & {
  input: { userId: string }
  output: { count: number } | null
}
const typedRun = await durably.getRun<MyRun>(runId)
```

### Query Runs

```ts
// Get failed runs
const failedRuns = await durably.getRuns({ status: 'failed' })

// Filter by job name with pagination
const runs = await durably.getRuns({
  jobName: 'sync-users', // also accepts string[] for multiple jobs
  status: 'completed',
  limit: 10,
  offset: 0,
})

// Filter by labels
const browserRuns = await durably.getRuns({
  labels: { source: 'browser' },
})

// Filter by labels (multi-tenancy)
const orgRuns = await durably.getRuns({
  labels: { organizationId: 'org_123' },
})

// Typed getRuns with generic parameter
type MyRun = Run & {
  input: { userId: string }
  output: { count: number } | null
}
const typedRuns = await durably.getRuns<MyRun>({ jobName: 'my-job' })
```

### Retrigger Failed Runs

```ts
// Creates a fresh run (new ID) with the same input/options
const newRun = await durably.retrigger(runId)
console.log(newRun.id) // new run ID
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
durably.on('run:leased', (e) => console.log('Leased:', e.runId))
durably.on('run:complete', (e) => console.log('Done:', e.output))
durably.on('run:fail', (e) => console.error('Failed:', e.error))
durably.on('run:cancel', (e) => console.log('Cancelled:', e.runId))
durably.on('run:delete', (e) => console.log('Deleted:', e.runId))
durably.on('run:progress', (e) =>
  console.log('Progress:', e.progress.current, '/', e.progress.total),
)

// Step events
durably.on('step:start', (e) => console.log('Step:', e.stepName))
durably.on('step:complete', (e) => console.log('Step done:', e.stepName))
durably.on('step:fail', (e) => console.error('Step failed:', e.stepName))
durably.on('step:cancel', (e) => console.log('Step cancelled:', e.stepName))

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
    case 'run:leased':
      console.log('Leased')
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

const handler = createDurablyHandler(durably, {
  sseThrottleMs: 100, // default: throttle progress SSE events (0 to disable)
  onRequest: async () => {
    // Called before each request (after auth) — useful for lazy init
    await durably.init()
  },
})

// Use the handle() method with automatic routing
app.all('/api/durably/*', async (req) => {
  return await handler.handle(req, '/api/durably')
})
```

**With auth middleware (multi-tenant):**

```ts
const handler = createDurablyHandler(durably, {
  auth: {
    // Required: authenticate every request. Throw Response to reject.
    authenticate: async (request) => {
      const session = await requireUser(request)
      const orgId = await resolveCurrentOrgId(request, session.user.id)
      return { orgId }
    },

    // Guard before trigger (called after body validation + job resolution)
    onTrigger: async (ctx, { jobName, input, labels }) => {
      if (labels?.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Guard before run-level operations (read, subscribe, steps, retrigger, cancel, delete)
    onRunAccess: async (ctx, run, { operation }) => {
      if (run.labels.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Scope runs list queries (GET /runs)
    scopeRuns: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),

    // Scope runs subscribe stream (GET /runs/subscribe). Falls back to scopeRuns if not set.
    scopeRunsSubscribe: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),
  },
})
```

**Label filtering via query params:**

```http
GET /runs?label.organizationId=org_123
GET /runs/subscribe?label.organizationId=org_123&label.env=prod
```

**Response Shape:** The `/runs` and `/run` endpoints return `ClientRun` objects (internal fields like `leaseOwner`, `leaseExpiresAt`, `idempotencyKey`, `concurrencyKey`, `updatedAt` are stripped). Use `toClientRun()` to apply the same projection in custom code:

```ts
import { toClientRun } from '@coji/durably'

const run = await durably.getRun(runId)
const clientRun = toClientRun(run) // strips internal fields
```

**Handler Interface:**

```ts
interface DurablyHandler {
  handle(request: Request, basePath: string): Promise<Response>
}

interface CreateDurablyHandlerOptions<
  TContext = undefined,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  onRequest?: () => Promise<void> | void
  sseThrottleMs?: number // default: 100
  auth?: AuthConfig<TContext, TLabels>
}

interface AuthConfig<
  TContext,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  authenticate: (request: Request) => Promise<TContext> | TContext
  onTrigger?: (
    ctx: TContext,
    trigger: TriggerRequest<TLabels>,
  ) => Promise<void> | void
  onRunAccess?: (
    ctx: TContext,
    run: Run<TLabels>,
    info: { operation: RunOperation },
  ) => Promise<void> | void
  scopeRuns?: (
    ctx: TContext,
    filter: RunFilter<TLabels>,
  ) => RunFilter<TLabels> | Promise<RunFilter<TLabels>>
  scopeRunsSubscribe?: (
    ctx: TContext,
    filter: RunsSubscribeFilter<TLabels>,
  ) => RunsSubscribeFilter<TLabels> | Promise<RunsSubscribeFilter<TLabels>>
}

type RunOperation =
  | 'read'
  | 'subscribe'
  | 'steps'
  | 'retrigger'
  | 'cancel'
  | 'delete'

// RunsSubscribeFilter is Pick<RunFilter, 'jobName' | 'labels'>

interface TriggerRequest<TLabels> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
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
  leaseInterval: 500,
  staleThreshold: 3000,
  jobs: {
    myJob: defineJob({
      name: 'my-job',
      input: z.object({}),
      run: async (step) => {
        /* ... */
      },
    }),
  },
})

// Initialize (same as Node.js)
await durably.init()
```

## Run Lifecycle

```text
trigger() → pending → leased → completed
                  ↘          ↗
                    → failed
```

- **pending**: Waiting for worker to pick up
- **leased**: Worker has acquired a lease and is executing steps
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
  run: (step: StepContext, input: TInput) => Promise<TOutput>
}

// AbortSignal is aborted when the run is cancelled
interface StepContext {
  runId: string
  run<T>(name: string, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T>
  progress(current: number, total?: number, message?: string): void
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

// TLabels defaults to Record<string, string> when no labels schema is provided
interface Run<TLabels extends Record<string, string> = Record<string, string>> {
  id: string
  jobName: string
  status: 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'
  input: unknown
  labels: TLabels
  output: unknown | null
  error: string | null
  progress: { current: number; total?: number; message?: string } | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

interface TypedRun<
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> extends Omit<Run<TLabels>, 'output'> {
  output: TOutput | null
}

interface JobHandle<
  TName extends string,
  TInput,
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  name: TName
  trigger(
    input: TInput,
    options?: TriggerOptions<TLabels>,
  ): Promise<TypedRun<TOutput, TLabels>>
  triggerAndWait(
    input: TInput,
    options?: TriggerAndWaitOptions<TLabels>,
  ): Promise<{ id: string; output: TOutput }>
  batchTrigger(
    inputs: BatchTriggerInput<TInput, TLabels>[],
  ): Promise<TypedRun<TOutput, TLabels>[]>
  getRun(id: string): Promise<TypedRun<TOutput, TLabels> | null>
  getRuns(
    filter?: Omit<RunFilter<TLabels>, 'jobName'>,
  ): Promise<TypedRun<TOutput, TLabels>[]>
}

interface TriggerOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  idempotencyKey?: string
  concurrencyKey?: string
  labels?: TLabels
}

interface TriggerAndWaitOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> extends TriggerOptions<TLabels> {
  timeout?: number
  onProgress?: (progress: ProgressData) => void | Promise<void>
  onLog?: (log: LogData) => void | Promise<void>
}

interface ProgressData {
  current: number
  total?: number
  message?: string
}

interface LogData {
  level: 'info' | 'warn' | 'error'
  message: string
  data?: unknown
  stepName?: string | null
}

interface RunFilter<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  jobName?: string | string[]
  labels?: Partial<TLabels>
  limit?: number
  offset?: number
}
```

## License

MIT
