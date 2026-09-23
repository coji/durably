# Durably - LLM Documentation

> Step-oriented resumable batch execution for Node.js and browsers using SQLite or PostgreSQL.

## Overview

Durably is a minimal workflow engine that persists step results to SQLite or PostgreSQL. If a job is interrupted (server restart, browser tab close, crash), it automatically resumes from the last successful step. Supports libSQL/Turso (single-server or serverless), PostgreSQL (recommended for multi-worker), and SQLocal (browser/OPFS).

## Installation

Requires Node.js 22+ for server use, Kysely `^0.27.0 || ^0.28.0 || ^0.29.0`, and Zod 4. This repository develops and tests on Node.js 24. Browser use requires a secure context and an OPFS-capable browser.

For libSQL client 0.18 with `@libsql/kysely-libsql@0.4.1`, use the targeted pnpm override documented in the [database guide](https://coji.github.io/durably/guide/databases#libsql-turso) so the dialect and application share compatible client types.

```bash
# Node.js with libSQL (recommended for single-server / Turso)
pnpm add @coji/durably kysely zod @libsql/client @libsql/kysely-libsql

# Node.js with better-sqlite3 (lightweight local alternative)
pnpm add @coji/durably kysely zod better-sqlite3

# Node.js with PostgreSQL (recommended for multi-worker)
pnpm add @coji/durably kysely zod pg

# Browser with SQLocal (OPFS-backed)
pnpm add @coji/durably kysely zod sqlocal
```

SSE responses use `Cache-Control: no-cache, no-transform` to avoid compression buffering. Configure reverse proxies to forward streamed chunks without buffering.

## Core Concepts

### 1. Durably Instance

```ts
import { createDurably } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

// --- libSQL local (single-server) ---
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

// --- Turso remote (serverless/edge) ---
// const client = createClient({
//   url: process.env.TURSO_DATABASE_URL!,
//   authToken: process.env.TURSO_AUTH_TOKEN!,
// })
// const dialect = new LibsqlDialect({ client })

// --- better-sqlite3 (lightweight local) ---
// import Database from 'better-sqlite3'
// import { SqliteDialect } from 'kysely'
// const dialect = new SqliteDialect({
//   database: new Database('local.db'),
// })

// --- PostgreSQL (multi-worker) ---
// import pg from 'pg'
// import { PostgresDialect } from 'kysely'
// const dialect = new PostgresDialect({
//   pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
// })

// Option 1: With jobs (1-step initialization, returns typed instance)
const durably = createDurably({
  dialect,
  pollingIntervalMs: 1000, // Delay before polling again when idle (ms)
  maxConcurrentRuns: 1, // Concurrent runs processed by the worker (default: 1)
  leaseRenewIntervalMs: 5000, // Lease renewal interval (ms)
  leaseMs: 30000, // Lease duration (ms); expired leases are reclaimed
  preserveSteps: false, // Set to true to keep step output data after terminal state (default: false = cleanup)
  retainRuns: '30d', // Auto-delete terminal runs older than 30 days (runs during worker polling; supports 'd', 'h', 'm' units)
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
console.log(run.disposition) // "created"

// Wait for completion
const result = await syncUsers.triggerAndWait(
  { orgId: 'org_123' },
  { timeout: 5000 },
)
console.log(result.output.syncedCount)
console.log(result.disposition) // "created"

// With idempotency key (prevents duplicate jobs)
const idempotentRun = await syncUsers.trigger(
  { orgId: 'org_123' },
  { idempotencyKey: 'webhook-event-456' },
)
console.log(idempotentRun.disposition) // "created" or "idempotent"

// With concurrency key (serializes execution, max 1 pending per key)
await syncUsers.trigger({ orgId: 'org_123' }, { concurrencyKey: 'org_123' })
// Second trigger with same key throws ConflictError if a pending run exists

// With coalesce: 'skip' or 'queue'
// In this release, 'skip' and 'queue' are behaviorally equivalent aliases:
// - If only a pending run exists, reuses it (disposition: 'coalesced')
// - If only an active leased run exists, creates one trailing pending run (disposition: 'created')
// - At most one trailing pending run exists per key; further triggers coalesce onto it
//   (unused input and labels are emitted via run:coalesced, not persisted)
// - Matching idempotencyKey takes precedence, returning disposition: 'idempotent'
// - If an active run expires with a pending replacement, the expired run fails; replacement remains pending
const queued = await syncUsers.trigger(
  { orgId: 'org_123' },
  { concurrencyKey: 'org_123', coalesce: 'queue' },
)
if (queued.disposition === 'coalesced') {
  console.log('Reused existing pending run:', queued.id)
}

// With coalesce: 'active'
// - Reuses the oldest pending run for the same job name and concurrency key
// - Otherwise reuses a leased run whose lease has not expired
// - Otherwise reuses the oldest waiting run
// - Otherwise creates a new pending run
// - Terminal runs and null/expired leases do not block a new run
// Selection is atomic at the database decision point. A reused leased run may
// become terminal before this caller observes the result.
const active = await syncUsers.trigger(
  { orgId: 'org_123' },
  { concurrencyKey: 'org_123', coalesce: 'active' },
)
console.log(active.id, active.status, active.disposition)

// With labels (for filtering)
await syncUsers.trigger({ orgId: 'org_123' }, { labels: { source: 'browser' } })

// Labels for multi-tenancy
await syncUsers.trigger(
  { orgId: 'org_123' },
  { labels: { organizationId: 'org_123', env: 'prod' } },
)
```

## Durable external waits

Use a durable wait when CI or a human decision should release the worker slot. Prepare the persisted input address **before** starting external work:

```ts
const wait = await step.prepareWait('ci:review-1', {
  metadata: { commit: input.commit },
  timeoutMs: 60_000,
})
await step.run('start-ci:review-1', () => startCi({ waitId: wait.id }))
const result = await step.waitFor(wait)
if (result.type === 'timeout') return { passed: false }
// result.payload is available only for a signal
```

An application process sharing the database supplies the result:

```ts
await durably.signal(waitId, { passed: true }, { signalId: 'ci-result-123' })
const receipt = await durably.getWait(waitId)
const waits = await durably.getWaits(runId)
```

`prepareWait(name, { metadata?, timeoutMs? })` returns a persisted `DurableWait`. `timeoutMs` must be a positive safe integer number of milliseconds whose resulting deadline fits the JavaScript date range. The first preparation fixes an absolute deadline; replay returns the original ID and deadline even if it supplies a different timeout or omits it. Omit `timeoutMs` for an unbounded wait. Names identify one logical wait within a run: replay returns its original result. Use distinct names for new iterations; retrigger creates new run and wait IDs. Metadata and payload must be JSON. The application validates authorization, payload schema, and commit/version identity; a wait ID is not an authorization credential.

`waitFor(wait)` returns `{ type: 'signal', payload }` or `{ type: 'timeout' }`. A result finalized before suspension returns immediately. Otherwise the run becomes `waiting`, releases its worker slot and lease, and resumes with the same run ID after a signal or deadline. A timeout is a normal job result, not an automatic failure or retry. Resume calls the job from the beginning and replays completed step results. Keep side effects inside named steps and use external idempotency keys where needed: a crash between an external effect and checkpoint persistence can repeat that effect. JavaScript stacks and local variables are not persisted.

Prepare and await waits only at sequential boundaries in the job body. Do not call them inside step callbacks, parallel branches, or while another step operation is in flight. Await `step.all()` before preparing a wait. Do not catch and suppress suspension or keep running application work after it; the runtime cannot stop arbitrary JavaScript. Suspension creates no step attempt.

The first signal or deadline wins. A new signal must arrive strictly before the persisted deadline; at the deadline it is rejected even if no worker has swept expired waits. Retrying an accepted signal with the same `signalId` and JSON payload returns the original receipt even after the deadline or run cancellation; a different payload or a second signal cannot overwrite it. An accepted receipt means persisted input, not completed downstream work. Unknown/deleted wait IDs are rejected. A signal for another prepared wait does not resume the wait currently blocking the run. New signals to terminal runs are rejected.

Waiting releases execution exclusion for `concurrencyKey`; another run with that key may execute. Resume waits for any valid same-key lease. Business resource reservations remain the application's responsibility. `coalesce: 'active'` selects pending, then valid leased, then waiting runs for the same job/key; `skip` and `queue` retain their pending-only reuse behavior. Resolved waits remain `waiting` until claimed. Candidate ordering follows creation time and ID, without a strict fairness guarantee.

Cancel a waiting run before deleting or retriggering it. Cancellation prevents a finalized signal or timeout from reviving it or starting downstream steps and cleans checkpoints according to `preserveSteps`, even without a worker. Wait records survive checkpoint cleanup and are removed with run deletion/purge. `getWait()` and `getWaits()` expose `deadlineAt`, `outcome`, `suspendedAt`, `firstResumedAt`, `inputWaitMs`, and `executionSlotWaitMs` alongside preparation and finalization times. Input wait counts from suspension to signal acceptance or deadline, floored at zero if the result wins during suspension handoff. Slot wait counts from the later of result finalization and suspension until the first resumed lease and stays `null` until that lease. A result consumed without suspension reports zero for both durations. `waitForRun()` and `triggerAndWait()` still wait for a terminal run; their caller-side timeout does not cancel a durable wait. The HTTP handler provides `GET /waits?runId=...`, `GET /wait?runId=...&waitId=...`, and `POST /signal?runId=...&waitId=...` with JSON `{ signalId, payload }`. All three routes check the owning run through `onRunAccess`; authenticated handlers must configure that hook for wait access. `auth.onSignal(ctx, run, wait, signal)` can reject invalid application payloads before persistence. The signal response contains `{ wait, disposition: 'accepted' | 'duplicate' }`; conflicts return 409, expired waits 410, unknown/cross-run IDs 404, and invalid JSON or missing fields 400. A same-ID, canonically identical retry returns `duplicate` with the original receipt.

`run:waiting` reports suspension and `run:leased` reports resume. Existing HTTP run reads/subscriptions and React hooks understand `waiting`. `isActive` remains pending or leased; `isWaiting` identifies waiting; `isTerminal` is false for waiting. Use `!isTerminal` when testing whether a run is unfinished.

After reconnecting, read `/run` and `/waits` to recover authoritative saved state. SSE events can be missed; a resolved wait may still belong to a `waiting` run until a worker claims it. The CI poller and local human-input HTTP examples are in `examples/server-libsql/`.

## Step Context API

The `step` object provides these methods:

### step.run(name, fn, options?)

Executes a step and persists its result. On resume, returns cached result without re-executing. The callback receives an `AbortSignal` that is aborted when the run is cancelled, enabling cooperative cancellation of long-running steps.

```ts
const result = await step.run('step-name', async (signal) => {
  return await someAsyncOperation({ signal })
})
```

Before attempting each callback invocation, Durably writes a durable attempt record. Cancellation, lease loss, or a crash can prevent the callback from being entered after that write. A replayed checkpoint does not create an attempt. Use the optional metadata to identify a model or external operation before it starts, then replace it with confirmed usage during the callback:

```ts
await step.run(
  'generate',
  async (signal, attempt) => {
    const result = await generate({ signal })
    await attempt.setMetadata({ model: 'example-model', usage: result.usage })
    return result.text
  },
  { metadata: { model: 'example-model' } },
)

const attempts = await durably.getStepAttempts(runId)
```

`attempt.id` identifies one durable attempt, not proof that the callback or an external operation began. `attempt.metadata` reflects the last successfully awaited replacement; `setMetadata()` replaces the entire JSON value rather than merging it. Omit `metadata` for an initial `null` value; passing `metadata: undefined` explicitly is invalid. Invalid values fail before execution or leave the previous value unchanged. `getStepAttempts()` returns attempts in start-time and ID order, or `[]` for an unknown run. A worker crash or checkpoint write failure can leave an attempt unresolved with `status: 'started'`, `completedAt: null`, and an inferred `interruptionReason` (`'lease-lost'`, `'cancelled'`, `'unknown'`, or `null`). This reason reflects the current persisted run state and may change until the run is terminal; it does not assert when external work stopped or fill in unknown usage. Attempts survive terminal checkpoint cleanup, and are deleted when the run is deleted or purged. `retainRuns` bounds their lifetime only after the run becomes terminal; cancel a run that keeps reclaiming to stop new attempts.

### step.all(branches)

Runs named steps concurrently and returns their results by name after every branch settles. Branches use the same checkpoint and attempt records as `step.run()`: after lease recovery, completed branches return their saved results while unfinished branches run again. Give each branch a stable name within the job; the numeric step index is assigned as each branch starts and need not match object key order. A branch can return an ordinary result such as `needsChanges`; a thrown error is an execution failure. If any branch throws, `step.all()` waits for the others to settle. Lease loss and cancellation take precedence over ordinary errors; with multiple ordinary failures, the error from the lowest-index failed checkpoint is thrown. Sibling attempts remain queryable after terminal failure. When a failed join has a successful sibling, its checkpoints and logs remain available even with the default `preserveSteps: false`, so the completed output is not lost. Other terminal runs still follow the normal checkpoint cleanup; `preserveSteps: true` keeps all terminal checkpoints. This does not release the worker slot while branches are running.

```ts
const reviews = await step.all({
  codex: async (signal, attempt) => {
    attempt.log.info('Codex review started')
    const result = await reviewWithCodex({ signal })
    await attempt.setMetadata({ usage: result.usage })
    return result.verdict
  },
  claude: async (signal, attempt) => {
    attempt.log.info('Claude review started')
    return (await reviewWithClaude({ signal })).verdict
  },
})
```

Use `attempt.log` inside parallel callbacks to attach logs to the correct branch. Once independent callbacks overlap, shared `step.log` has no step name until all active callbacks settle, avoiding false attribution from late logs. Sequentially nested `step.run()` callbacks keep the innermost step name. Individual durations are available from attempt timestamps; the earliest start and latest completion give the group's wall-clock interval, including recovery time when applicable. Sum branch durations only when measuring total branch work, not elapsed time.

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

For parallel callbacks, use `attempt.log` for reliable step attribution.

## Run Management

### Wait for Existing Run

```ts
// Wait for an existing run to complete (no new run created)
// Useful when Job A triggers Job B and returns B's run ID
const completedRun = await durably.waitForRun(runId)
console.log(completedRun.output) // available when completed

// With timeout and callbacks
const run = await durably.waitForRun(runId, {
  timeout: 10000,
  onProgress: (p) => console.log(`${p.current}/${p.total}`),
  onLog: (l) => console.log(l.message),
})

// Same-process listeners settle waits immediately; if another runtime completes the run
// against the same storage, the wait falls back to storage polling. Optional
// `pollingIntervalMs` overrides the instance `createDurably({ pollingIntervalMs })` for this call only.
await durably.waitForRun(runId, { pollingIntervalMs: 2000 })

// Throws NotFoundError if run doesn't exist
// Throws CancelledError if run is cancelled
// Throws Error if run fails
```

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

`getRuns()` returns runs newest first, ordered by creation time and then ID, so pages are stable even when runs share a millisecond.

```ts
// Get failed runs
const failedRuns = await durably.getRuns({ status: 'failed' })

// Get active runs (multiple statuses)
const activeRuns = await durably.getRuns({ status: ['pending', 'leased'] })

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
// Creates a fresh run (new ID) with the same input and labels
// Input is validated against the current job schema — throws if incompatible
// Note: idempotencyKey is not carried forward
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

### Purge Old Runs

Batch-delete terminal runs (completed, failed, cancelled) older than a cutoff date.
Pending, leased, and waiting runs are never deleted.

```ts
// Delete terminal runs older than 30 days
const deleted = await durably.purgeRuns({
  olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  limit: 500, // optional batch size (default: 500)
})
```

For automatic cleanup, use the `retainRuns` option (see Core Concepts). Cleanup runs during idle worker polling cycles, at most once per minute, in batches of 100.

## Events

Subscribe to job execution events. **Listeners run synchronously** in the worker's hot path — keep them fast and non-blocking. Use fire-and-forget (`void asyncFn()`) for expensive work. Exceptions and rejected promises from listeners go to `onError`; an exception from `onError` itself is ignored and never stops delivery to other listeners.

Run and step state events (`run:trigger`, `run:coalesced`, `run:leased`, `run:waiting`, `run:complete`, `run:fail`, `run:cancel`, `run:delete`, `step:start`, `step:complete`, `step:fail`) are emitted directly after their storage write, with no other storage access in between, so a listener that reads the run sees the new state. The reverse is not guaranteed: a poller can read the new state just before the event arrives, so wait for the event when you need its payload. With `preserveSteps: false`, terminal checkpoint and log cleanup, where it applies (see `step.all()` for when a failed run keeps them), starts once listeners return; listeners are not awaited, so async listeners may find steps already deleted. A failed cleanup after `cancel()` is reported as `worker:error` with `context: 'cancel-cleanup'`. Events are in-process only; other runtimes on the same database see state, not events. `step:cancel` follows a read-back of the run. `run:progress` persists in the background, and `log:write` is stored only with `withLogPersistence()`. Maintenance transitions (idle lease release or expiry failure, wait deadline expiry, retention purges) emit no events.

```ts
// Run lifecycle events
// Note: run:trigger is NOT emitted on idempotent hits (disposition: 'idempotent')
durably.on('run:trigger', (e) => console.log('Triggered:', e.runId))
durably.on('run:coalesced', (e) =>
  console.log(
    'Coalesced:',
    e.runId,
    e.status, // 'pending', 'leased', or 'waiting'
    'skipped input:',
    e.skippedInput,
  ),
)
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

### Core event categories

The `DurablyEvent` union is grouped for callers who want lifecycle facts vs operational detail:

- **Domain** (`DomainEvent` / `DomainEventType`): `run:trigger`, `run:coalesced`, `run:waiting`, `run:complete`, `run:fail`, `run:cancel`, `run:delete`
- **Operational** (`OperationalEvent` / `OperationalEventType`): `run:leased`, `run:lease-renewed`, `run:progress`, `step:*`, `log:write`, `worker:error`

Use `isDomainEvent(event)` (checks `event.type` only) as a type guard.

```ts
import { isDomainEvent, type DurablyEvent } from '@coji/durably'

function handleEvent(event: DurablyEvent) {
  if (isDomainEvent(event)) {
    console.log('State change:', event.type, event.runId)
  }
}
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

Every supplied label must match. The same filters apply to the initial run list and the `/runs/subscribe` event stream, including `run:trigger`, `run:coalesced`, and `run:leased` projections. HTTP trigger responses include the selected run's current `status`; active coalescing can therefore return `pending`, `leased`, or `waiting` with disposition `coalesced`.

**Response Shape:** The `/runs` and `/run` endpoints return `ClientRun` objects (internal fields like `leaseOwner`, `leaseExpiresAt`, `idempotencyKey`, `concurrencyKey`, `leaseGeneration`, `updatedAt` are stripped). Each response includes derived `isTerminal`, `isActive`, and `isWaiting` booleans from `status` (terminal: completed, failed, or cancelled; active: pending or leased; waiting: waiting). Use `toClientRun()` to apply the same projection in custom code:

```ts
import { toClientRun } from '@coji/durably'

const run = await durably.getRun(runId)
const clientRun = toClientRun(run) // strips internal fields; adds isTerminal / isActive / isWaiting
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
  onSignal?: (
    ctx: TContext,
    run: Run<TLabels>,
    wait: DurableWait,
    signal: { signalId: string; payload: JsonValue },
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
  | 'waits'
  | 'signal'

// RunsSubscribeFilter is Pick<RunFilter, 'jobName' | 'labels'>

interface TriggerRequest<TLabels> {
  jobName: string
  input: unknown
  idempotencyKey?: string
  concurrencyKey?: string
  coalesce?: 'skip' | 'queue' | 'active'
  labels?: TLabels
}

interface TriggerResponse {
  runId: string
  disposition: Disposition
  status: RunStatus
}
```

## Plugins

### Log Persistence

```ts
import { withLogPersistence } from '@coji/durably'

durably.use(withLogPersistence())
```

## SQLite WAL Maintenance

For local SQLite backends using WAL mode, Durably automatically runs periodic WAL checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)`) during idle maintenance to prevent unbounded WAL file growth. This is probed at `migrate()` time and only enabled when the backend supports it — automatically skipped for Turso (remote libSQL), PostgreSQL, and browser (OPFS) backends.

## Browser Usage

```ts
import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

const { dialect } = new SQLocalKysely('app.sqlite3')

const durably = createDurably({
  dialect,
  pollingIntervalMs: 100,
  leaseRenewIntervalMs: 500,
  leaseMs: 3000,
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
- **waiting**: Execution suspended for external input; a resolved wait awaits a new lease
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
type StepCallback<T> = (
  signal: AbortSignal,
  attempt: StepAttemptContext,
) => T | Promise<T>

interface StepContext {
  prepareWait(
    name: string,
    options?: { metadata?: JsonValue; timeoutMs?: number },
  ): Promise<DurableWait>
  waitFor(
    wait: DurableWait,
  ): Promise<{ type: 'signal'; payload: JsonValue } | { type: 'timeout' }>
  readonly runId: string
  readonly signal: AbortSignal
  isAborted(): boolean
  throwIfAborted(): void
  run<T>(
    name: string,
    fn: (signal: AbortSignal, attempt: StepAttemptContext) => T | Promise<T>,
    options?: { metadata?: JsonValue },
  ): Promise<T>
  all<const T extends Record<string, StepCallback<unknown>>>(
    branches: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }>
  progress(current: number, total?: number, message?: string): void
  log: {
    info(message: string, data?: unknown): void
    warn(message: string, data?: unknown): void
    error(message: string, data?: unknown): void
  }
}

interface StepAttemptContext {
  readonly id: string
  readonly metadata: JsonValue | null
  readonly log: StepContext['log']
  setMetadata(value: JsonValue): Promise<void>
}

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface StepAttempt {
  id: string
  runId: string
  stepName: string
  stepIndex: number
  leaseGeneration: number
  status: 'started' | 'completed' | 'failed'
  metadata: JsonValue | null
  startedAt: string
  completedAt: string | null
  error: string | null
  interruptionReason: 'lease-lost' | 'cancelled' | 'unknown' | null
}

// TLabels defaults to Record<string, string> when no labels schema is provided
interface Run<TLabels extends Record<string, string> = Record<string, string>> {
  id: string
  jobName: string
  status:
    'pending' | 'leased' | 'waiting' | 'completed' | 'failed' | 'cancelled'
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

type Disposition = 'created' | 'idempotent' | 'coalesced'

interface TypedRun<
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
> extends Omit<Run<TLabels>, 'output'> {
  output: TOutput | null
}

type TriggerResult<TOutput, TLabels> = TypedRun<TOutput, TLabels> & {
  disposition: Disposition
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
  ): Promise<TriggerResult<TOutput, TLabels>>
  triggerAndWait(
    input: TInput,
    options?: TriggerAndWaitOptions<TLabels>,
  ): Promise<TriggerAndWaitResult<TOutput>>
  batchTrigger(
    inputs: BatchTriggerInput<TInput, TLabels>[],
  ): Promise<TriggerResult<TOutput, TLabels>[]>
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
  coalesce?: 'skip' | 'queue' | 'active'
  labels?: TLabels
}

interface TriggerAndWaitResult<TOutput> {
  id: string
  output: TOutput
  disposition: Disposition
}

interface WaitForRunOptions {
  timeout?: number
  onProgress?: (progress: ProgressData) => void | Promise<void>
  onLog?: (log: LogData) => void | Promise<void>
}

interface TriggerAndWaitOptions<
  TLabels extends Record<string, string> = Record<string, string>,
>
  extends TriggerOptions<TLabels>, WaitForRunOptions {}

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
  status?: RunStatus | RunStatus[]
  jobName?: string | string[]
  labels?: Partial<TLabels>
  limit?: number
  offset?: number
}
```

## Error Classes

Durably exports typed error classes for programmatic error handling:

```ts
import {
  DurablyError, // Base class with statusCode (extends Error)
  NotFoundError, // 404 — resource not found
  ValidationError, // 400 — invalid input or request
  ConflictError, // 409 — operation conflicts with current state
  WaitExpiredError, // 410 — wait deadline expired
  CancelledError, // Run was cancelled during execution
  LeaseLostError, // Worker lost lease ownership
} from '@coji/durably'
```

`DurablyError` subclasses (`NotFoundError`, `ValidationError`, `ConflictError`, `WaitExpiredError`) carry a `statusCode` property and are used by the HTTP handler to return appropriate responses.

## License

MIT

### DurableWait

```ts
interface DurableWait {
  id: string
  runId: string
  name: string
  metadata: JsonValue | null
  status: 'pending' | 'resolved' | 'cancelled' | 'closed'
  payload: JsonValue | null
  signalId: string | null
  createdAt: string
  resolvedAt: string | null
  deadlineAt: string | null
  outcome: 'signal' | 'timeout' | null
  suspendedAt: string | null
  firstResumedAt: string | null
  inputWaitMs: number | null
  executionSlotWaitMs: number | null
}
```

A pending wait has no result; a resolved wait has an immutable signal or timeout `outcome`. Cancelled and closed waits no longer accept input. `getWait` returns `null` for an unknown ID, and `getWaits` returns an empty list for an unknown run. Signal delivery raises `NotFoundError` for missing IDs, `ConflictError` for conflicting or closed input, `WaitExpiredError` (a `ConflictError` subtype) for expired input, and `ValidationError` for invalid arguments. `payload: null` is also a valid signal: inspect `outcome` to distinguish it from timeout or missing input. `inputWaitMs` measures external-input waiting only after suspension; `executionSlotWaitMs` measures from the later of suspension and result finalization until the first resumed lease, and remains `null` until resume. Wait records created before the deadline/timing migration may have unknown historical durations (`null`).
