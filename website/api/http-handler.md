# HTTP Handler

Expose Durably via HTTP/SSE endpoints for React clients and external integrations.

## createDurablyHandler

Create a handler that routes HTTP requests to the appropriate Durably operations.

```ts
import { createDurablyHandler } from '@coji/durably'

const handler = createDurablyHandler(durably, {
  onRequest: async () => {
    // Called before each request - useful for lazy initialization
    await durably.init()
  },
})
```

### Options

```ts
interface CreateDurablyHandlerOptions<TContext, TLabels> {
  /** Called before handling each request (after authentication) */
  onRequest?: () => Promise<void> | void

  /**
   * Throttle interval (ms) for SSE progress events.
   * First and last progress events are always delivered immediately.
   * Set to 0 to disable. Default: 100
   */
  sseThrottleMs?: number

  /** Auth middleware. When set, authenticate is required and applies to ALL endpoints. */
  auth?: AuthConfig<TContext, TLabels>
}
```

## Framework Integration

### React Router / Remix

Use a splat route to handle all Durably endpoints under a single path.

```ts
// app/routes/api.durably.$.ts
import { durablyHandler } from '~/lib/durably.server'
import type { Route } from './+types/api.durably.$'

export async function loader({ request }: Route.LoaderArgs) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function action({ request }: Route.ActionArgs) {
  return durablyHandler.handle(request, '/api/durably')
}
```

### Next.js

```ts
// app/api/durably/[...path]/route.ts
import { durablyHandler } from '@/lib/durably'

export async function GET(request: Request) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function POST(request: Request) {
  return durablyHandler.handle(request, '/api/durably')
}

export async function DELETE(request: Request) {
  return durablyHandler.handle(request, '/api/durably')
}
```

### Express / Hono

```ts
// Express
app.use('/api/durably', async (req, res, next) => {
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
  })
  const response = await handler.handle(request, '/api/durably')
  res.status(response.status)
  response.headers.forEach((v, k) => res.setHeader(k, v))
  res.send(await response.text())
})

// Hono
app.all('/api/durably/*', (c) => handler.handle(c.req.raw, '/api/durably'))
```

## Response Shape

The `/runs` and `/run` endpoints return `ClientRun` objects — a subset of the full `Run` type with internal fields (`leaseOwner`, `leaseExpiresAt`, `idempotencyKey`, `concurrencyKey`, `leaseGeneration`, `updatedAt`) stripped, plus **`isTerminal`**, **`isActive`**, and **`isWaiting`** derived from `status`. Use `toClientRun()` to apply the same projection in custom code:

```ts
import { toClientRun } from '@coji/durably'

const run = await durably.getRun(runId)
const clientRun = toClientRun(run) // strips internal fields; adds isTerminal / isActive / isWaiting
```

## Endpoints

The handler provides these endpoints:

| Method   | Path                           | Description                              |
| -------- | ------------------------------ | ---------------------------------------- |
| `POST`   | `/trigger`                     | Trigger a job                            |
| `GET`    | `/subscribe?runId=xxx`         | SSE stream for run events                |
| `GET`    | `/runs`                        | List runs with filtering                 |
| `GET`    | `/run?runId=xxx`               | Get single run                           |
| `GET`    | `/steps?runId=xxx`             | Get steps for a run                      |
| `GET`    | `/waits?runId=xxx`             | List persisted waits for a run           |
| `GET`    | `/wait?runId=xxx&waitId=yyy`   | Read one wait                            |
| `POST`   | `/signal?runId=xxx&waitId=yyy` | Submit a wait signal                     |
| `GET`    | `/runs/subscribe`              | SSE stream for run list updates          |
| `POST`   | `/retrigger?runId=xxx`         | Retrigger a failed run (creates new run) |
| `POST`   | `/cancel?runId=xxx`            | Cancel a pending, leased, or waiting run |
| `DELETE` | `/run?runId=xxx`               | Delete a run                             |

## Durable waits over HTTP

Every wait route requires `runId`; single-wait routes also require `waitId`. The handler checks the run with `onRunAccess` before returning or changing a wait and rejects a wait ID belonging to another run with 404. If `auth` is configured, wait routes require an `onRunAccess` hook. A wait ID is never an authorization credential.

```http
GET /api/durably/waits?runId=run_abc123
GET /api/durably/wait?runId=run_abc123&waitId=wait_123
POST /api/durably/signal?runId=run_abc123&waitId=wait_123
Content-Type: application/json

{"signalId":"ci-check-123","payload":{"commit":"abc123","passed":true}}
```

`GET /waits` returns a `DurableWait[]` in creation order; `GET /wait` returns one `DurableWait`. The persisted fields include `status`, `outcome`, `payload`, `deadlineAt`, and lifecycle timestamps. The signal response is `{ "wait": DurableWait, "disposition": "accepted" | "duplicate" }`. A same-ID, same-payload retry returns the original receipt with `duplicate`, even after the deadline or run completion. A conflicting signal returns 409; a deadline-expired wait returns 410; unknown or cross-run wait IDs return 404. Malformed JSON, a missing `payload`, or an empty `signalId` returns 400. `null` is a valid payload.

Use `auth.onSignal` to validate the application payload and its target before persistence. For example, compare a CI result's commit with the commit saved in wait metadata and the owning run's input. The core validates JSON and idempotency; the application decides whether a result is valid for its business operation.

SSE can announce `run:waiting` and a resumed lease, but it is not a durable notification queue. On connection or reconnection, read `/run` and `/waits` to recover the saved run and wait state. A wait can have `outcome: "signal"` or `"timeout"` while the run remains `waiting` for a worker slot.

## Trigger Request

```ts
// POST /api/durably/trigger
{
  "jobName": "import-csv",
  "input": { "filename": "data.csv" },
  "idempotencyKey": "unique-key",   // optional
  "concurrencyKey": "user-123",     // optional
  "coalesce": "active",             // optional ('skip' | 'queue' | 'active') — requires concurrencyKey
  "labels": { "organizationId": "org_123" }  // optional
}

// Response
{ "runId": "run_abc123", "disposition": "coalesced", "status": "leased" }
// disposition: "created" | "idempotent" | "coalesced"
// When disposition is not "created", runId refers to the existing run.
// idempotencyKey match returns "idempotent" (takes priority over coalesce).
```

::: info SSE behavior
`run:trigger` is **not** emitted for idempotent or coalesced triggers. A `run:coalesced` event is emitted instead when coalescing returns an existing pending, leased, or waiting run, and includes that run's `status`. With `'active'`, the server prefers a pending run, otherwise reuses a non-expired leased run, otherwise a waiting run, otherwise creates a pending run. Idempotency takes precedence. Expired or null leases and terminal runs do not block creation.
:::

## SSE Event Stream

The `/subscribe` endpoint returns Server-Sent Events for real-time updates. SSE responses use `Cache-Control: no-cache, no-transform` so compression middleware does not buffer events. Reverse proxies must also forward streamed chunks without buffering.

```ts
// GET /api/durably/subscribe?runId=run_abc123

// Events:
data: {"type":"run:leased","runId":"run_abc123","jobName":"import-csv",...}

data: {"type":"run:progress","runId":"run_abc123","progress":{"current":1,"total":10},...}

data: {"type":"step:complete","runId":"run_abc123","stepName":"parse",...}

data: {"type":"run:complete","runId":"run_abc123","output":{"count":10},...}
```

The stream closes automatically when the run completes or fails.

## List Runs

```ts
// GET /api/durably/runs?jobName=import-csv&status=completed&label.organizationId=org_123&limit=10&offset=0
// Multiple jobName params filter by any of them:
// GET /api/durably/runs?jobName=import-csv&jobName=sync-users
// Multiple label params use AND logic:
// GET /api/durably/runs?label.env=prod&label.region=us-east

// Response
{
  "runs": [
    {
      "id": "run_abc123",
      "jobName": "import-csv",
      "status": "completed",
      "input": { "filename": "data.csv" },
      "output": { "count": 10 },
      "createdAt": "2024-01-01T00:00:00.000Z",
      "completedAt": "2024-01-01T00:01:00.000Z"
    }
  ],
  "total": 100,
  "hasMore": true
}
```

The same `jobName` and `label.<key>` filters apply to `GET /runs/subscribe`. Every supplied label must match, so scoped clients receive only matching `run:trigger`, `run:coalesced`, and `run:leased` events.

## Auth Middleware

Built-in auth middleware for multi-tenant apps. When `auth` is configured, `authenticate` is called on every request before any processing.

```ts
const handler = createDurablyHandler(durably, {
  auth: {
    // Required: authenticate every request. Return context or throw Response to reject.
    authenticate: async (request) => {
      const session = await requireUser(request)
      const orgId = await resolveCurrentOrgId(request, session.user.id)
      return { orgId }
    },

    // Guard before trigger (called AFTER body validation and job resolution)
    onTrigger: async (ctx, { jobName, input, labels }) => {
      if (labels?.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Guard before run-level operations
    onRunAccess: async (ctx, run, { operation }) => {
      if (run.labels.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    onSignal: async (ctx, run, wait, { signalId, payload }) => {
      // Validate the application payload and target before persisting input.
      if (!isValidDecisionForRun(payload, run, wait)) {
        throw new Response('Invalid decision', { status: 400 })
      }
    },

    // Scope runs list queries (GET /runs)
    scopeRuns: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),

    // Scope runs subscribe stream (GET /runs/subscribe)
    // Falls back to scopeRuns if not set
    scopeRunsSubscribe: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),
  },
})
```

### AuthConfig

```ts
interface AuthConfig<TContext, TLabels> {
  /** Authenticate every request. Return context or throw Response to reject. */
  authenticate: (request: Request) => Promise<TContext> | TContext

  /** Guard before trigger. Called after body validation and job resolution. */
  onTrigger?: (
    ctx: TContext,
    trigger: TriggerRequest<TLabels>,
  ) => Promise<void> | void

  /** Guard before run-level operations. Run is pre-fetched. */
  onRunAccess?: (
    ctx: TContext,
    run: Run<TLabels>,
    info: { operation: RunOperation },
  ) => Promise<void> | void

  /** Validate and authorize a wait signal before persistence. */
  onSignal?: (
    ctx: TContext,
    run: Run<TLabels>,
    wait: DurableWait,
    signal: { signalId: string; payload: JsonValue },
  ) => Promise<void> | void

  /** Scope runs list queries (GET /runs). */
  scopeRuns?: (
    ctx: TContext,
    filter: RunFilter<TLabels>,
  ) => RunFilter<TLabels> | Promise<RunFilter<TLabels>>

  /** Scope runs subscribe stream. Falls back to scopeRuns if not set. */
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
```

### Execution Order

1. `authenticate(request)` — fail fast before anything else
2. `onRequest()` — lazy init (migrations, worker start)
3. Validate request (parse body/params)
4. Auth hook (`onTrigger`, `onRunAccess`, `scopeRuns`, or `scopeRunsSubscribe`)
5. Execute operation

### Rejecting Requests

Auth hooks reject requests by throwing a `Response`:

```ts
throw new Response('Forbidden', { status: 403 })
```

This pattern is framework-agnostic and works with React Router, Next.js, Hono, etc.

### TContext Generic

`TContext` is automatically inferred from the return type of `authenticate`. All other hooks receive the same typed context:

```ts
// TContext is inferred as { orgIds: Set<string> }
auth: {
  authenticate: async (request) => {
    return { orgIds: new Set(['org_1', 'org_2']) }
  },
  onTrigger: async (ctx, trigger) => {
    ctx.orgIds // Set<string> — fully typed
  },
}
```

### TLabels Generic

`TLabels` is inferred from the `Durably` instance when a labels schema is provided via `createDurably({ labels: z.object({...}) })`. This provides type-safe labels throughout auth hooks.
