# Getting Started

## Choose Your Setup

| Setup | Description | Guide |
|-------|-------------|-------|
| **Server** | Run jobs on Node.js server | [→](/guide/server) |
| **Full-Stack** | Server execution + React UI for monitoring | [→](/guide/full-stack) |
| **Browser-Only** | Run entirely in the browser (no server) | [→](/guide/browser-only) |

## Quick Start (Server)

The simplest way to get started.

### 1. Install

```bash
npm install @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

### 2. Define a Job

```ts
// jobs.ts
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

// Create Durably instance
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })
const durably = createDurably({ dialect })

// Define a job
const syncUsersJob = defineJob({
  name: 'sync-users',
  input: z.object({ orgId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    // Step 1: Fetch users
    const users = await step.run('fetch', async () => {
      const res = await fetch(`https://api.example.com/orgs/${payload.orgId}/users`)
      return res.json()
    })

    // Step 2: Save to database
    await step.run('save', async () => {
      // Your database logic here
      console.log(`Saving ${users.length} users`)
    })

    return { count: users.length }
  },
})

// Register the job
const syncUsers = durably.register(syncUsersJob)

// Initialize and start
await durably.migrate()
durably.start()

// Trigger a job
await syncUsers.trigger({ orgId: 'org_123' })
```

### 3. Run

```bash
npx tsx jobs.ts
```

If the process crashes after step 1, restarting will skip the fetch and continue from step 2.

## Next Steps

Learn the concepts:
- [Jobs and Steps](/guide/jobs-and-steps) - How jobs and steps work
- [Resumability](/guide/resumability) - How resumption works
- [Events](/guide/events) - Monitor job execution

Choose your setup:
- [Server](/guide/server) - Detailed server-side guide
- [Full-Stack](/guide/full-stack) - React Router v7 + React hooks
- [Browser-Only](/guide/browser-only) - Browser-only with SQLite WASM
