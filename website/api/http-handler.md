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
interface CreateDurablyHandlerOptions {
  /** Called before handling each request */
  onRequest?: () => Promise<void> | void
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

## Endpoints

The handler provides these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trigger` | Trigger a job |
| `GET` | `/subscribe?runId=xxx` | SSE stream for run events |
| `GET` | `/runs` | List runs with filtering |
| `GET` | `/run?runId=xxx` | Get single run |
| `GET` | `/steps?runId=xxx` | Get steps for a run |
| `GET` | `/runs/subscribe` | SSE stream for run list updates |
| `POST` | `/retry?runId=xxx` | Retry a failed run |
| `POST` | `/cancel?runId=xxx` | Cancel a running job |
| `DELETE` | `/run?runId=xxx` | Delete a run |

## Trigger Request

```ts
// POST /api/durably/trigger
{
  "jobName": "import-csv",
  "input": { "filename": "data.csv" },
  "idempotencyKey": "unique-key",   // optional
  "concurrencyKey": "user-123"      // optional
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
// GET /api/durably/runs?jobName=import-csv&status=completed&limit=10&offset=0

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

## Individual Handlers

For custom routing, access individual handlers directly:

```ts
const handler = createDurablyHandler(durably)

// Use specific handlers
app.post('/jobs/trigger', (req) => handler.trigger(req))
app.get('/jobs/subscribe', (req) => handler.subscribe(req))
app.get('/jobs/runs', (req) => handler.runs(req))
app.get('/jobs/run', (req) => handler.run(req))
app.get('/jobs/steps', (req) => handler.steps(req))
app.post('/jobs/retry', (req) => handler.retry(req))
app.post('/jobs/cancel', (req) => handler.cancel(req))
app.delete('/jobs/run', (req) => handler.delete(req))
app.get('/jobs/runs/subscribe', (req) => handler.runsSubscribe(req))
```

## Security Considerations

The handler exposes all registered jobs and run data. In production:

1. **Authentication**: Add middleware to verify requests before reaching the handler
2. **Authorization**: Check user permissions for specific jobs or runs
3. **Rate Limiting**: Protect against abuse

```ts
// Example with authentication middleware
export async function action({ request }: Route.ActionArgs) {
  const user = await getUser(request)
  if (!user) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Add user context to the request if needed
  return durablyHandler.handle(request, '/api/durably')
}
```
