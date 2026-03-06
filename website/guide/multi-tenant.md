# Multi-Tenant

Isolate job data per organization using labels and scoped queries. Builds on the [Authentication](/guide/auth) guide.

## The Pattern

1. **Labels** — Tag every run with its organization ID at trigger time
2. **`scopeRuns`** — Auto-filter run listings to the current tenant
3. **`onRunAccess`** — Block access to other tenants' runs
4. **`onTrigger`** — Validate labels on new runs

## Full Setup

```ts
// app/lib/durably.server.ts
import { createDurably, createDurablyHandler } from '@coji/durably'

const durably = createDurably({
  dialect,
  jobs: { importCsv: importCsvJob },
})

export const durablyHandler = createDurablyHandler(durably, {
  auth: {
    // 1. Authenticate and resolve the current org
    authenticate: async (request) => {
      const session = await getSession(request)
      if (!session) throw new Response('Unauthorized', { status: 401 })
      const orgId = await resolveOrg(request, session.userId)
      return { userId: session.userId, orgId }
    },

    // 2. Ensure triggered runs have correct org label
    onTrigger: async (ctx, { labels }) => {
      if (labels?.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // 3. Block access to other orgs' runs
    onRunAccess: async (ctx, run) => {
      if (run.labels.organizationId !== ctx.orgId) {
        throw new Response('Forbidden', { status: 403 })
      }
    },

    // 4. Auto-filter listings to current org
    scopeRuns: async (ctx, filter) => ({
      ...filter,
      labels: { ...filter.labels, organizationId: ctx.orgId },
    }),
  },
})

await durably.init()
```

## Triggering with Labels

On the client, include the org label:

```ts
const run = await durably.jobs.importCsv.trigger(
  { filename: 'data.csv', rows },
  { labels: { organizationId: currentOrgId } },
)
```

Or from a server action:

```ts
export async function action({ request }: Route.ActionArgs) {
  const session = await getSession(request)
  const orgId = await resolveOrg(request, session.userId)

  const run = await durably.jobs.importCsv.trigger(
    { filename: 'data.csv', rows },
    { labels: { organizationId: orgId } },
  )
  return { runId: run.id }
}
```

## Scoped Dashboard

With `scopeRuns` configured, `useRuns` automatically returns only the current tenant's runs — no client-side filtering needed:

```tsx
function Dashboard() {
  const { runs } = durablyClient.useRuns({ pageSize: 10 })
  // runs only contains the current org's runs

  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id}>
          {run.jobName}: {run.status}
        </li>
      ))}
    </ul>
  )
}
```

## SSE Scoping

SSE subscriptions are also scoped. By default, `scopeRunsSubscribe` falls back to `scopeRuns`. Override it for custom SSE filtering:

```ts
auth: {
  // ...other hooks

  // Custom SSE scoping (optional — defaults to scopeRuns)
  scopeRunsSubscribe: async (ctx, filter) => ({
    ...filter,
    labels: { ...filter.labels, organizationId: ctx.orgId },
  }),
}
```

This means `durablyClient.useRuns()` only receives real-time updates for the current tenant's runs.

## Role-Based Access per Tenant

Combine tenant isolation with role-based access control:

```ts
auth: {
  authenticate: async (request) => {
    const session = await getSession(request)
    if (!session) throw new Response('Unauthorized', { status: 401 })
    const { orgId, role } = await getOrgMembership(session.userId)
    return { userId: session.userId, orgId, role }
  },

  onTrigger: async (ctx) => {
    if (ctx.role === 'viewer') {
      throw new Response('Forbidden', { status: 403 })
    }
  },

  onRunAccess: async (ctx, run, { operation }) => {
    // Tenant isolation
    if (run.labels.organizationId !== ctx.orgId) {
      throw new Response('Forbidden', { status: 403 })
    }
    // Role check for mutations
    const writeOps = ['retry', 'cancel', 'delete']
    if (writeOps.includes(operation) && ctx.role === 'viewer') {
      throw new Response('Forbidden', { status: 403 })
    }
  },

  scopeRuns: async (ctx, filter) => ({
    ...filter,
    labels: { ...filter.labels, organizationId: ctx.orgId },
  }),
}
```

## Labels Are Immutable

Labels are set at trigger time and cannot be changed. They are `Record<string, string>` — simple key-value pairs.

```ts
// Set at trigger time
await job.trigger(input, {
  labels: {
    organizationId: 'org_123',
    env: 'production',
    region: 'us-east',
  },
})

// Filter by multiple labels (AND logic)
const runs = await durably.getRuns({
  labels: { organizationId: 'org_123', env: 'production' },
})
```

All run-scoped events include labels, enabling SSE filtering:

```
GET /api/durably/runs/subscribe?label.organizationId=org_123
```

## Type-Safe Labels

Use a labels schema for compile-time validation:

```ts
import { z } from 'zod'

const durably = createDurably({
  dialect,
  labels: z.object({
    organizationId: z.string(),
    env: z.enum(['production', 'staging']),
  }),
  jobs: { importCsv: importCsvJob },
})
```

Now `TLabels` is inferred throughout the auth hooks — `run.labels.organizationId` is typed as `string`, and `run.labels.env` is typed as `'production' | 'staging'`.

## Next Steps

- **[Authentication](/guide/auth)** — Basic auth setup and framework examples
- **[Deployment Guide](/guide/deployment)** — Choose the right mode for your app
- **[HTTP Handler Reference](/api/http-handler)** — Full AuthConfig type definition
