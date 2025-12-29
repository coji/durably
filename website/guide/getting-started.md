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

// Define a CSV import job
const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({ filePath: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    // Step 1: Parse CSV
    const rows = await step.run('parse', async () => {
      const fs = await import('fs/promises')
      const csv = await fs.readFile(payload.filePath, 'utf-8')
      return csv.split('\n').slice(1).map((line) => line.split(','))
    })

    // Step 2: Import rows
    await step.run('import', async () => {
      // Your database logic here
      console.log(`Importing ${rows.length} rows`)
    })

    return { count: rows.length }
  },
})

// Register the job
const { importCsv } = durably.register({
  importCsv: importCsvJob,
})

// Initialize and start
await durably.migrate()
durably.start()

// Trigger a job
await importCsv.trigger({ filePath: './data/users.csv' })
```

### 3. Run

```bash
npx tsx jobs.ts
```

If the process crashes after step 1, restarting will skip the parse and continue from step 2.

## Next Steps

Learn the concepts:
- [Jobs and Steps](/guide/jobs-and-steps) - How jobs and steps work
- [Resumability](/guide/resumability) - How resumption works
- [Events](/guide/events) - Monitor job execution

Choose your setup:
- [Server](/guide/server) - Detailed server-side guide
- [Full-Stack](/guide/full-stack) - React Router v7 + React hooks
- [Browser-Only](/guide/browser-only) - Browser-only with SQLite WASM
