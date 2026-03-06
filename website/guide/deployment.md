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
    pollingInterval: 1000, // default, good for production
    heartbeatInterval: 5000, // default
    staleThreshold: 30000, // default
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
    pollingInterval: 100,
    heartbeatInterval: 500,
    staleThreshold: 3000,
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
