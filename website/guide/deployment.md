# Deployment Guide

Choose the right Durably mode for your application.

## Three Modes

|                 | Server                  | Fullstack               | SPA                     |
| --------------- | ----------------------- | ----------------------- | ----------------------- |
| **Jobs run on** | Node.js                 | Node.js                 | Browser                 |
| **Storage**     | libsql / better-sqlite3 | Same (server-side)      | SQLite WASM + OPFS      |
| **UI**          | None (CLI, cron, API)   | React via SSE           | React (local)           |
| **Offline**     | No                      | No                      | Yes                     |
| **Multi-user**  | Yes (API)               | Yes (SSE)               | No (single tab)         |
| **Package**     | `@coji/durably`         | `+ @coji/durably-react` | `+ @coji/durably-react` |

## Decision Flowchart

```
Do you need a UI?
├── No → Server Mode
│   (cron, CLI, data pipelines)
│
└── Yes → Does data need to stay on the user's device?
    ├── Yes → SPA Mode
    │   (offline-first, local-only)
    │
    └── No → Fullstack Mode
        (most web apps)
```

## Server Mode

**Use for:** cron jobs, data pipelines, CLI tools, microservices.

```ts
import { createDurably } from '@coji/durably'

const durably = createDurably({ dialect, jobs: { ... } })
await durably.init()

// Trigger and wait
const { output } = await durably.jobs.myJob.triggerAndWait({ ... })

// Or trigger and let the worker handle it
await durably.jobs.myJob.trigger({ ... })
```

No HTTP handler, no React — just `@coji/durably`. See [Server Mode guide](/guide/server-mode).

### Production Tips

- Use [Turso](https://turso.tech) or a remote libsql URL for persistent storage
- Set longer intervals in production to reduce DB load:
  ```ts
  createDurably({
    dialect,
    pollingIntervalMs: 1000, // default, good for production
    leaseRenewIntervalMs: 5000, // default
    leaseMs: 30000, // default
  })
  ```
- Use `concurrencyKey` to prevent parallel runs of the same job
- Use `idempotencyKey` for deduplication in cron/webhook triggers

## Fullstack Mode

**Use for:** most web apps with background jobs and real-time UI.

Two packages:

- `@coji/durably` — server-side: jobs, worker, HTTP handler
- `@coji/durably-react` — client-side: type-safe hooks via SSE

```
app/lib/durably.server.ts  →  createDurably + createDurablyHandler
app/lib/durably.ts          →  createDurably<typeof server>({ api })
app/routes/api.durably.$.ts →  splat route
```

See [Fullstack Mode guide](/guide/fullstack-mode).

### Framework Support

| Framework          | Route Pattern                        |
| ------------------ | ------------------------------------ |
| React Router/Remix | `app/routes/api.durably.$.ts`        |
| Next.js            | `app/api/durably/[...path]/route.ts` |
| Hono               | `app.all('/api/durably/*', ...)`     |

See [HTTP Handler](/api/http-handler#framework-integration) for full examples.

### Production Tips

- Add [auth middleware](/guide/auth) for any public-facing deployment
- Use `onRequest` for lazy initialization:
  ```ts
  createDurablyHandler(durably, {
    onRequest: async () => {
      await durably.init() // Safe to call multiple times
    },
  })
  ```
- SSE progress events are throttled at 100ms by default (configurable via `sseThrottleMs`)

## SPA Mode

**Use for:** offline-capable apps, local-first apps, prototyping.

Everything runs in the browser. Uses SQLocal for SQLite WASM with OPFS.

```ts
import { createDurably } from '@coji/durably'
import { DurablyProvider, useJob } from '@coji/durably-react/spa'
```

See [SPA Mode guide](/guide/spa-mode).

### Requirements

- HTTPS or localhost (OPFS needs Secure Context)
- COOP/COEP headers (SharedArrayBuffer)
- Single tab only (OPFS exclusive access)

### Production Tips

- Set shorter intervals for responsive UX:
  ```ts
  createDurably({
    dialect: sqlocal.dialect,
    pollingIntervalMs: 100,
    leaseRenewIntervalMs: 500,
    leaseMs: 3000,
  })
  ```
- For Vercel/Netlify, add headers via config:
  ```json
  {
    "headers": [
      {
        "source": "/(.*)",
        "headers": [
          { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" },
          { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" }
        ]
      }
    ]
  }
  ```

## Job Versioning and Deploys

When you deploy updated job definitions, in-flight runs may be affected. Durably matches steps by **name** (not index), which makes most changes safe.

### Safe Changes (no special handling)

| Change            | What happens                                                 |
| ----------------- | ------------------------------------------------------------ |
| Add new steps     | New step has no cached data, runs normally                   |
| Change step logic | Completed steps return cached output, new steps run new code |
| Reorder steps     | Name-based matching, order doesn't matter                    |
| Delete steps      | Old step data is ignored                                     |

### Risky Changes (be careful)

| Change                  | Risk                                               | Mitigation                                                                |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| Rename a step           | Old cached output doesn't match — step re-executes | Safe if the step is idempotent                                            |
| Change step output type | Old cached output returned with wrong type         | Rename the step so it re-executes                                         |
| Change input schema     | Pending runs have old-format input                 | `retrigger()` validates against current schema and throws if incompatible |

### Breaking Changes (cancel first)

For these, cancel running/pending runs before deploying:

```ts
// Cancel all runs for a job before deploy
const runs = await durably.jobs.myJob.getRuns({ status: 'pending' })
for (const run of runs) {
  await durably.cancel(run.id)
}
```

- **Renaming a job** — old runs reference the former name and become orphaned
- **Fundamental logic rewrite** — in-flight runs may produce incorrect results

### General Guidance

- **Steps should be idempotent** — re-execution after deploy is always safe if steps don't have side effects beyond their return value
- **Same approach as Cloudflare Workflows** — no version pinning or managed infrastructure required
- Durably uses `retrigger()` (not retry) to re-run failed jobs. `retrigger()` validates the input against the current schema, so stale runs with incompatible input are caught early

## Migrating Between Modes

### Server → Fullstack

1. Add `@coji/durably-react`
2. Add `createDurablyHandler` + splat route
3. Create client with `createDurably<typeof server>({ api })`
4. Job definitions stay the same

### Fullstack → SPA

1. Replace server dialect with SQLocal
2. Move job registrations to browser code
3. Switch imports from `@coji/durably-react` to `@coji/durably-react/spa`
4. Wrap app with `DurablyProvider`
5. Job definitions stay the same

## Next Steps

- **[Quick Start](/guide/quick-start)** — Try Durably in 2 minutes
- **[Error Handling](/guide/error-handling)** — Handle failures gracefully
- **[Authentication](/guide/auth)** — Protect your endpoints
