# Auth & Multi-Tenant

Protect Durably endpoints and isolate data per tenant. Built into `createDurablyHandler` — no extra middleware needed.

## Overview

The auth system has four hooks:

| Hook           | Purpose                                 |
| -------------- | --------------------------------------- |
| `authenticate` | Validate every request (required)       |
| `onTrigger`    | Guard before creating a run             |
| `onRunAccess`  | Guard before reading/retrying/canceling |
| `scopeRuns`    | Filter run listings to current tenant   |

All hooks receive a typed context from `authenticate`.

## Basic Auth

Authenticate requests and attach context:

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'
import { importCsvJob } from '~/jobs/import-csv'

const durably = createDurably({
  dialect,
  jobs: { importCsv: importCsvJob },
})

export const durablyHandler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      const session = await getSession(request)
      if (!session) {
        throw new Response('Unauthorized', { status: 401 })
      }
      return { userId: session.userId, role: session.role }
    },
  },
})

await durably.init()
```

Now every request to `/api/durably/*` must pass authentication. Throw a `Response` to reject.

## Multi-Tenant Isolation

Use labels to tag runs by organization, then scope all queries:

```ts
export const durablyHandler = createDurablyHandler(durably, {
  auth: {
    authenticate: async (request) => {
      const session = await getSession(request)
      if (!session) throw new Response('Unauthorized', { status: 401 })
      const orgId = await resolveOrg(request, session.userId)
      return { userId: session.userId, orgId }
    },

    // Ensure triggered runs belong to the user's org
    onTrigger: async (ctx, { labels }) => {
      if (labels?.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Ensure users can only access their org's runs
    onRunAccess: async (ctx, run) => {
      if (run.labels.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // Auto-filter run listings to current org
    scopeRuns: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),
  },
})
```

### Triggering with Labels

On the client, include the org label when triggering:

```ts
const run = await durably.jobs.importCsv.trigger(
  { filename: 'data.csv', rows },
  { labels: { organizationId: currentOrgId } },
)
```

Or enforce it server-side in `onTrigger` by modifying the trigger request.

## Role-Based Access

Restrict operations based on user roles:

```ts
auth: {
  authenticate: async (request) => {
    const session = await getSession(request)
    if (!session) throw new Response('Unauthorized', { status: 401 })
    return { userId: session.userId, role: session.role, orgId: session.orgId }
  },

  // Only admins can trigger jobs
  onTrigger: async (ctx) => {
    if (ctx.role !== 'admin') {
      throw new Response('Forbidden', { status: 403 })
    }
  },

  // Viewers can read, only admins can retry/cancel/delete
  onRunAccess: async (ctx, run, { operation }) => {
    if (run.labels.organizationId !== ctx.orgId) {
      throw new Response('Forbidden', { status: 403 })
    }
    const writeOps = ['retry', 'cancel', 'delete']
    if (writeOps.includes(operation) && ctx.role !== 'admin') {
      throw new Response('Forbidden', { status: 403 })
    }
  },

  scopeRuns: async (ctx, filter) => ({
    ...filter,
    labels: { ...filter.labels, organizationId: ctx.orgId },
  }),
}
```

## Execution Order

Understanding when each hook runs:

1. **`authenticate(request)`** — first, fail fast
2. **`onRequest()`** — lazy init (migrations, etc.)
3. **Validate request** — parse body/params
4. **Auth hook** — `onTrigger`, `onRunAccess`, or `scopeRuns`
5. **Execute operation**

## SSE Scoping

SSE subscriptions are also scoped. `scopeRunsSubscribe` controls what events a client receives on the `/runs/subscribe` endpoint. Falls back to `scopeRuns` if not set.

```ts
auth: {
  // ... authenticate, scopeRuns, etc.

  // Custom SSE scoping (optional — defaults to scopeRuns)
  scopeRunsSubscribe: async (ctx, filter) => ({
    ...filter,
    labels: { ...filter.labels, organizationId: ctx.orgId },
  }),
}
```

## Type Safety

`TContext` is inferred from `authenticate`'s return type. All hooks get the same typed context:

```ts
// ctx is typed as { userId: string; orgId: string; role: 'admin' | 'viewer' }
auth: {
  authenticate: async (request) => {
    return { userId: '...', orgId: '...', role: 'admin' as const }
  },
  onTrigger: async (ctx, trigger) => {
    ctx.orgId   // string — fully typed
    ctx.role    // 'admin' | 'viewer' — fully typed
  },
}
```

## Next Steps

- **[Deployment Guide](/guide/deployment)** — Choose the right mode for your app
- **[HTTP Handler Reference](/api/http-handler)** — Full endpoint and auth config docs
- **[Error Handling](/guide/error-handling)** — Handle failures gracefully
