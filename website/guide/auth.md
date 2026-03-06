# Authentication

Protect Durably API endpoints with built-in auth middleware. No extra packages needed — `createDurablyHandler` handles everything.

## How It Works

Add `auth.authenticate` to your handler. It runs on every request before any processing:

```ts
const handler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      // Validate the request — throw Response to reject
      const session = await getSession(request)
      if (!session) {
        throw new Response('Unauthorized', { status: 401 })
      }
      // Return value becomes the typed context for other hooks
      return { userId: session.userId }
    },
  },
})
```

That's it. Every request to `/api/durably/*` now requires authentication.

## Rejecting Requests

Auth hooks reject by throwing a `Response`. This is framework-agnostic:

```ts
// 401 — not authenticated
throw new Response('Unauthorized', { status: 401 })

// 403 — authenticated but not allowed
throw new Response('Forbidden', { status: 403 })
```

## Guarding Operations

Beyond authentication, you can guard specific operations:

```ts
auth: {
  authenticate: async (request) => {
    const session = await getSession(request)
    if (!session) throw new Response('Unauthorized', { status: 401 })
    return { userId: session.userId, role: session.role }
  },

  // Guard before creating a run
  onTrigger: async (ctx, { jobName }) => {
    if (ctx.role !== 'admin') {
      throw new Response('Forbidden', { status: 403 })
    }
  },

  // Guard before read/retry/cancel/delete
  onRunAccess: async (ctx, run, { operation }) => {
    // Everyone can read, only admins can mutate
    const writeOps = ['retry', 'cancel', 'delete']
    if (writeOps.includes(operation) && ctx.role !== 'admin') {
      throw new Response('Forbidden', { status: 403 })
    }
  },
}
```

### Available Operations

`onRunAccess` receives the operation type:

| Operation   | Endpoint         |
| ----------- | ---------------- |
| `read`      | `GET /run`       |
| `subscribe` | `GET /subscribe` |
| `steps`     | `GET /steps`     |
| `retry`     | `POST /retry`    |
| `cancel`    | `POST /cancel`   |
| `delete`    | `DELETE /run`    |

## Execution Order

1. **`authenticate(request)`** — fail fast, before anything else
2. **`onRequest()`** — lazy init (migrations, etc.)
3. **Validate request** — parse body/params
4. **Auth hook** — `onTrigger`, `onRunAccess`, or `scopeRuns`
5. **Execute operation**

## Type-Safe Context

`TContext` is inferred from `authenticate`'s return type. All hooks get the same typed context — no manual type annotations needed:

```ts
auth: {
  authenticate: async (request) => {
    // Return type becomes TContext
    return { userId: 'u_123', role: 'admin' as const }
  },
  onTrigger: async (ctx) => {
    ctx.userId // string
    ctx.role   // 'admin'
  },
}
```

## Framework Examples

### React Router / Remix

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { getSession } from '~/lib/session.server'

const durably = createDurably({ dialect, jobs: { importCsv: importCsvJob } })

export const durablyHandler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      const session = await getSession(request.headers.get('Cookie'))
      if (!session.userId) throw new Response('Unauthorized', { status: 401 })
      return { userId: session.userId }
    },
  },
})

await durably.init()
```

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
// lib/durably.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { auth } from '@/lib/auth'

const durably = createDurably({ dialect, jobs: { importCsv: importCsvJob } })

export const durablyHandler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      const session = await auth()
      if (!session?.user) throw new Response('Unauthorized', { status: 401 })
      return { userId: session.user.id }
    },
  },
})

await durably.init()
```

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

### Hono

```ts
import { Hono } from 'hono'
import { createDurably, createDurablyHandler } from '@coji/durably'

const durably = createDurably({ dialect, jobs: { importCsv: importCsvJob } })

const handler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      const apiKey = request.headers.get('X-API-Key')
      if (apiKey !== process.env.API_KEY) {
        throw new Response('Unauthorized', { status: 401 })
      }
      return { apiKey }
    },
  },
})

await durably.init()

const app = new Hono()
app.all('/api/durably/*', (c) => handler.handle(c.req.raw, '/api/durably'))
```

## Next Steps

- **[Multi-Tenant](/guide/multi-tenant)** — Isolate data per organization with labels and scoped queries
- **[HTTP Handler Reference](/api/http-handler)** — Full auth config and endpoint docs
- **[Error Handling](/guide/error-handling)** — Handle failures gracefully
