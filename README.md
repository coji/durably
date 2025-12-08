# durably

Step-oriented resumable batch execution for Node.js and browsers using SQLite.

> **Note**: This package is under development. The API is not yet implemented.

## Features (Planned)

- Resumable batch processing with step-level persistence
- Works in both Node.js and browsers
- Uses SQLite for state management (better-sqlite3, libsql, or WASM)
- Minimal dependencies - just Kysely as a peer dependency
- Event system for monitoring and extensibility
- Plugin architecture for optional features

## Installation

```bash
npm install @coji/durably kysely better-sqlite3
```

## Usage (Preview)

```ts
import { createClient, defineJob } from '@coji/durably'
import Database from 'better-sqlite3'
import { BetterSqlite3Dialect } from 'kysely'

const dialect = new BetterSqlite3Dialect({
  database: new Database('app.db'),
})

const client = createClient({ dialect })

const syncUsers = defineJob('sync-users', async (ctx, payload: { orgId: string }) => {
  const users = await ctx.run('fetch-users', async () => {
    return api.fetchUsers(payload.orgId)
  })

  await ctx.run('save-to-db', async () => {
    await db.upsertUsers(users)
  })
})

client.register(syncUsers)
await client.migrate()
client.start()

await syncUsers.trigger({ orgId: 'org_123' })
```

## License

MIT
