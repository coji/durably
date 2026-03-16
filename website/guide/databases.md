# Choosing a Database

Durably supports multiple database backends through Kysely dialects. This guide helps you pick the right one.

## At a Glance

| Backend                   | Best for                | Workers  | Setup           |
| ------------------------- | ----------------------- | -------- | --------------- |
| **libSQL** (local)        | Single-server Node.js   | 1        | Zero config     |
| **Turso** (remote libSQL) | Serverless / edge       | 1 per DB | Managed service |
| **better-sqlite3**        | CLI tools, scripts      | 1        | Zero config     |
| **PostgreSQL**            | Multi-worker production | Many     | Requires server |
| **SQLocal**               | Browser-only (OPFS)     | 1 tab    | Zero config     |

## Decision Flowchart

```text
Running in the browser?
  Yes → SQLocal (only option)
  No ↓

Need multiple workers processing jobs concurrently?
  Yes → PostgreSQL
  No ↓

Deploying to serverless / edge (Vercel, Cloudflare)?
  Yes → Turso (remote libSQL)
  No ↓

Need a lightweight embedded DB?
  Yes → libSQL (local) or better-sqlite3
```

## libSQL (Local)

**Recommended default for Node.js.** Zero-config embedded database that works everywhere.

```bash
pnpm add @libsql/client @libsql/kysely-libsql
```

```ts
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'

const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })
```

- Single file on disk
- No external dependencies
- Same dialect works with Turso remote (just change the URL)

## Turso (Remote libSQL)

**For serverless and edge deployments.** Managed libSQL database with global replication.

```bash
pnpm add @libsql/client @libsql/kysely-libsql
```

```ts
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
})
const dialect = new LibsqlDialect({ client })
```

- Same `LibsqlDialect` as local — just swap the URL
- Works on Vercel, Cloudflare Workers, Fly.io
- Free tier available at [turso.tech](https://turso.tech)

::: tip
See the [fullstack-vercel-turso example](https://github.com/coji/durably/tree/main/examples/fullstack-vercel-turso) for a complete Vercel + Turso deployment.
:::

## better-sqlite3

**For CLI tools and scripts.** Lightweight synchronous SQLite with no native dependencies on most platforms.

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
- No Turso remote support (use libSQL if you might need remote later)

## PostgreSQL

**For multi-worker production deployments.** The only backend that supports multiple workers processing jobs concurrently from the same database.

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

::: warning
SQLite backends (libSQL, better-sqlite3) are single-writer. Running multiple workers against the same SQLite file will cause lock contention. Use PostgreSQL for multi-worker setups.
:::

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
