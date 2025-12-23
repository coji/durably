# Getting Started

## Installation

::: code-group

```bash [npm]
npm install @coji/durably kysely zod
```

```bash [pnpm]
pnpm add @coji/durably kysely zod
```

```bash [yarn]
yarn add @coji/durably kysely zod
```

:::

### Node.js

For Node.js, you'll also need a SQLite driver:

::: code-group

```bash [libsql (recommended)]
npm install @libsql/client @libsql/kysely-libsql
```

```bash [better-sqlite3]
npm install better-sqlite3
```

:::

### Browser

For browsers, use SQLite WASM with OPFS:

```bash
npm install sqlocal
```

## Quick Start

### Node.js Example

```ts
import { createDurably, defineJob } from '@coji/durably'
import { createClient } from '@libsql/client'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

// Create SQLite client
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

// Initialize Durably
const durably = createDurably({ dialect })

// Define a job
const processOrderJob = defineJob({
  name: 'process-order',
  input: z.object({ orderId: z.string() }),
  output: z.object({ status: z.string() }),
  run: async (step, payload) => {
    // Step 1: Validate order
    const order = await step.run('validate', async () => {
      return await validateOrder(payload.orderId)
    })

    // Step 2: Process payment
    await step.run('payment', async () => {
      await processPayment(order)
    })

    // Step 3: Send confirmation
    await step.run('notify', async () => {
      await sendConfirmation(order)
    })

    return { status: 'completed' }
  },
})

// Register the job
const processOrder = durably.register(processOrderJob)

// Start the worker and run migrations
await durably.migrate()
durably.start()

// Trigger a job
await processOrder.trigger({ orderId: 'order_123' })
```

### Browser Example

```ts
import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Create SQLite client with OPFS
const { dialect } = new SQLocalKysely('app.sqlite3')

// Initialize Durably
const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})

// Define and register jobs the same way as Node.js
const syncData = durably.register(
  defineJob({
    name: 'sync-data',
    input: z.object({ userId: z.string() }),
    run: async (step, payload) => {
      const data = await step.run('fetch', async () => {
        return await fetchUserData(payload.userId)
      })

      await step.run('save', async () => {
        await saveLocally(data)
      })
    },
  }),
)

await durably.migrate()
durably.start()
```

## Next Steps

- [Jobs and Steps](/guide/jobs-and-steps) - Learn about defining jobs and steps
- [Resumability](/guide/resumability) - Understand how resumption works
- [Events](/guide/events) - Monitor job execution with events
