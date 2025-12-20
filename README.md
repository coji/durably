# durably

Step-oriented resumable batch execution for Node.js and browsers using SQLite.

> **Note**: This package is under development. The API is not yet implemented.

## Features (Planned)

- Resumable batch processing with step-level persistence
- Works in both Node.js and browsers
- Uses SQLite for state management (Turso/libsql for Node.js, SQLocal for browsers)
- Minimal dependencies - just Kysely as a peer dependency
- Event system for monitoring and extensibility
- Plugin architecture for optional features

## Installation

```bash
npm install @coji/durably kysely @libsql/client @libsql/kysely-libsql
```

## Usage (Preview)

```ts
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'

const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

const durably = createDurably({ dialect })

const syncUsers = durably.defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ syncedCount: z.number() }),
}, async (ctx, payload) => {
  const users = await ctx.run('fetch-users', async () => {
    return api.fetchUsers(payload.orgId)
  })

  await ctx.run('save-to-db', async () => {
    await db.upsertUsers(users)
  })

  return { syncedCount: users.length }
})

await durably.migrate()
durably.start()

await syncUsers.trigger({ orgId: 'org_123' })
```

## Documentation

- [Specification](docs/spec.md) - Core API and concepts
- [Streaming Extension](docs/spec-streaming.md) - AI Agent workflow support
- [Implementation Plan](docs/implementation-plan.md) - TDD implementation roadmap

## License

MIT
