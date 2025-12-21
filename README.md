# durably

Step-oriented resumable batch execution for Node.js and browsers using SQLite.

**[Documentation](https://coji.github.io/durably/)** | **[Live Demo](https://durably-demo.vercel.app)**

## Features

- Resumable batch processing with step-level persistence
- Works in both Node.js and browsers
- Uses SQLite for state management (better-sqlite3/libsql for Node.js, SQLite WASM for browsers)
- Minimal dependencies - just Kysely and Zod as peer dependencies
- Event system for monitoring and extensibility
- Type-safe input/output with Zod schemas

## Installation

```bash
# Node.js with better-sqlite3
npm install @coji/durably kysely zod better-sqlite3

# Node.js with libsql
npm install @coji/durably kysely zod @libsql/client @libsql/kysely-libsql

# Browser with SQLocal
npm install @coji/durably kysely zod sqlocal
```

## Usage

```ts
import { createDurably } from '@coji/durably'
import SQLite from 'better-sqlite3'
import { SqliteDialect } from 'kysely'
import { z } from 'zod'

const dialect = new SqliteDialect({
  database: new SQLite('local.db'),
})

const durably = createDurably({ dialect })

const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
    output: z.object({ syncedCount: z.number() }),
  },
  async (context, payload) => {
    const users = await context.run('fetch-users', async () => {
      return api.fetchUsers(payload.orgId)
    })

    await context.run('save-to-db', async () => {
      await db.upsertUsers(users)
    })

    return { syncedCount: users.length }
  },
)

await durably.migrate()
durably.start()

await syncUsers.trigger({ orgId: 'org_123' })
```

## Documentation

- [Specification](docs/spec.md) - Core API and concepts
- [Streaming Extension](docs/spec-streaming.md) - AI Agent workflow support (conceptual, not yet implemented)

## License

MIT
