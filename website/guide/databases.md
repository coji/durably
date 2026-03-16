# Choosing a Database

Durably supports multiple database backends through Kysely dialects. This guide helps you pick the right one.

## At a Glance

### SQLite Family (Single-Writer)

| Backend               | Serverless                  | Setup                                  | Performance                      | Cost                                             |
| --------------------- | --------------------------- | -------------------------------------- | -------------------------------- | ------------------------------------------------ |
| **libSQL / Turso**    | Local: Limited, Remote: Yes | Zero config (local) / Managed (remote) | Fast local, edge-friendly remote | Free (local) / Free tier + pay-as-you-go (Turso) |
| **better-sqlite3**    | No                          | Zero config                            | Fast (synchronous)               | Free                                             |
| **SQLocal** (browser) | N/A                         | Zero config                            | Browser-local (OPFS)             | Free (client-side)                               |

### PostgreSQL (Multi-Writer)

- **Serverless**: Varies (Neon: yes, RDS: no)
- **Setup**: Server required
- **Performance**: Strong under concurrency (advisory locks + `FOR UPDATE SKIP LOCKED`)
- **Cost**: Self-hosted or managed (Neon, Supabase, RDS)

::: warning
**Local SQLite** (libSQL local, better-sqlite3) is single-writer — multiple workers on the same file will cause lock contention. **Turso remote** accepts multiple connections, but concurrency key enforcement is weaker than PostgreSQL (no advisory locks). For reliable multi-worker setups, use PostgreSQL.
:::

## Decision Flowchart

```text
Running in the browser?
  Yes → SQLocal (only option)
  No ↓

Large volume of jobs, or multiple app servers sharing one DB?
(e.g. high-traffic API, queue with thousands of jobs/hour)
  Yes → PostgreSQL (strongest guarantees)
        Turso also works (weaker concurrency key enforcement)
  No ↓

Deploying to serverless / edge (Vercel, Cloudflare)?
  Yes → Turso (remote libSQL)
  No ↓

Single server or CLI script?
  Yes → libSQL (local) or better-sqlite3
```

## libSQL / Turso

**Recommended default.** libSQL works as a local embedded database and as a managed remote database via [Turso](https://turso.tech). Same `LibsqlDialect` for both — just change the URL.

```bash
pnpm add @libsql/client @libsql/kysely-libsql
```

```ts
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'

// Local (single file on disk)
const client = createClient({ url: 'file:local.db' })

// Turso remote (serverless / edge)
// const client = createClient({
//   url: process.env.TURSO_DATABASE_URL!,
//   authToken: process.env.TURSO_AUTH_TOKEN!,
// })

const dialect = new LibsqlDialect({ client })
```

- **Local**: Single file, zero config, no external dependencies
- **Turso**: Managed service with global replication, free tier available
- Works on Vercel, Cloudflare Workers, Fly.io

::: tip
See the [fullstack-vercel-turso example](https://github.com/coji/durably/tree/main/examples/fullstack-vercel-turso) for a complete Vercel + Turso deployment.
:::

## better-sqlite3

**For CLI tools and scripts.** Lightweight synchronous SQLite with prebuilt binaries for most platforms (may require build tools where prebuilds are unavailable).

```bash
pnpm add better-sqlite3
```

```ts
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

const dialect = new SqliteDialect({
  database: new Database('local.db'),
})
```

- Synchronous API (slightly faster for small workloads)
- Good for one-off scripts and CLI tools
- No remote support (use libSQL if you might need Turso later)

## PostgreSQL

**For multi-worker production deployments.** The recommended backend for running multiple workers concurrently, with advisory locks and `FOR UPDATE SKIP LOCKED` for strong concurrency guarantees.

```bash
pnpm add pg
```

```ts
import pg from 'pg'
import { PostgresDialect } from 'kysely'

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  }),
})
```

- Multiple workers can poll and claim jobs safely (advisory locks + fencing tokens)
- Connection pooling via `pg.Pool`
- Works with any PostgreSQL provider (Neon, Supabase, RDS, self-hosted)

## SQLocal (Browser)

**For browser-only apps.** Runs SQLite in the browser using OPFS (Origin Private File System).

```bash
pnpm add sqlocal
```

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect } = new SQLocalKysely('app.sqlite3')
```

- Data persists across page reloads (OPFS)
- Requires Secure Context (HTTPS or localhost)
- Single tab usage (OPFS exclusive lock)
- See the [SPA Mode guide](/guide/spa-mode) for React integration

## Switching Backends

All backends use the same `dialect` parameter in `createDurably()`. To switch, just change the dialect — no other code changes needed:

```ts
const durably = createDurably({
  dialect, // ← swap this
  jobs: { myJob },
})
```

The database schema is created automatically by `durably.init()` (or `durably.migrate()`). Durably does not support migrating data between backends.
