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

The `/runs` and `/run` endpoints return `ClientRun` objects — a subset of the full `Run` type with internal fields (`heartbeatAt`, `idempotencyKey`, `concurrencyKey`, `updatedAt`) stripped. Use `toClientRun()` to apply the same projection in custom code:

```ts
import { toClientRun } from '@coji/durably'

const run = await durably.getRun(runId)
const clientRun = toClientRun(run) // strips internal fields
```

## Endpoints

The handler provides these endpoints:

| Method   | Path                   | Description                     |
| -------- | ---------------------- | ------------------------------- |
| `POST`   | `/trigger`             | Trigger a job                   |
| `GET`    | `/subscribe?runId=xxx` | SSE stream for run events       |
| `GET`    | `/runs`                | List runs with filtering        |
| `GET`    | `/run?runId=xxx`       | Get single run                  |
| `GET`    | `/steps?runId=xxx`     | Get steps for a run             |
| `GET`    | `/runs/subscribe`      | SSE stream for run list updates |
| `POST`   | `/retry?runId=xxx`     | Retry a failed run              |
| `POST`   | `/cancel?runId=xxx`    | Cancel a running job            |
| `DELETE` | `/run?runId=xxx`       | Delete a run                    |

## Trigger Request

```ts
// POST /api/durably/trigger
{
  "jobName": "import-csv",
  "input": { "filename": "data.csv" },
  "idempotencyKey": "unique-key",   // optional
  "concurrencyKey": "user-123",     // optional
  "labels": { "organizationId": "org_123" }  // optional
}

// Response
{ "runId": "run_abc123" }
```

## SSE Event Stream

The `/subscribe` endpoint returns Server-Sent Events for real-time updates.

```ts
// GET /api/durably/subscribe?runId=run_abc123

// Events:
data: {"type":"run:start","runId":"run_abc123","jobName":"import-csv",...}

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

## Auth Middleware

Built-in auth middleware for multi-tenant apps. When `auth` is configured, `authenticate` is called on every request before any processing.

```ts
const handler = createDurablyHandler(durably, {
  auth: {
    // Required: authenticate every request. Return context or throw Response to reject.
    authenticate: async (request) => {
      const session = await requireUser(request)
      const orgs = await getUserOrganizations(session.user.id)
      return { orgIds: new Set(orgs.map((o) => o.id)) }
    },

    // Guard before trigger (called AFTER body validation and job resolution)
    onTrigger: async (ctx, { jobName, input, labels }) => {
      if (!ctx.orgIds.has(labels?.organizationId)) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Guard before run-level operations
    onRunAccess: async (ctx, run, { operation }) => {
      if (!ctx.orgIds.has(run.labels.organizationId)) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Scope runs list queries (GET /runs)
    scopeRuns: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.currentOrgId },
    }),

    // Scope runs subscribe stream (GET /runs/subscribe)
    // Falls back to scopeRuns if not set
    scopeRunsSubscribe: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.currentOrgId },
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
  | 'retry'
  | 'cancel'
  | 'delete'
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
