# Quick Start

Run your first resumable job in a single file. No server, no UI — just Node.js.

## Install

```bash
pnpm add @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

## Write a Job

Create `main.ts`:

```ts
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

// 1. Define a job with steps
const greetJob = defineJob({
  name: 'greet',
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  run: async (step, input) => {
    // Each step is a checkpoint — cached on success
    const greeting = await step.run('build-greeting', () => {
      return `Hello, ${input.name}!`
    })

    await step.run('log-it', () => {
      console.log(greeting)
    })

    return { message: greeting }
  },
})

// 2. Create Durably instance
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

const durably = createDurably({
  dialect,
  jobs: { greet: greetJob },
})

// 3. Initialize and run
await durably.init()

const { id, output } = await durably.jobs.greet.triggerAndWait({
  name: 'World',
})
console.log(`Run ${id} completed:`, output)
// => Run run_xxx completed: { message: "Hello, World!" }

await durably.stop()
await durably.db.destroy()
```

## Run It

```bash
npx tsx main.ts
```

That's it. The job ran, each step was persisted to `local.db`, and you got the output back.

## What Just Happened?

1. **`defineJob`** created a job with two steps
2. **`createDurably`** set up the engine with SQLite storage
3. **`init()`** created tables and started the worker
4. **`triggerAndWait()`** queued the job and waited for completion
5. Each **`step.run()`** saved its result — if you run it again with the same idempotency key, cached results are returned instantly

## Try Resumability

Add a step that fails, then see it resume:

```ts
const riskyJob = defineJob({
  name: 'risky',
  input: z.object({}),
  output: z.object({ result: z.string() }),
  run: async (step) => {
    await step.run('step-1', () => {
      console.log('Step 1: running')
      return 'done'
    })

    await step.run('step-2', () => {
      console.log('Step 2: running')
      // Uncomment to simulate crash:
      // throw new Error('boom!')
      return 'done'
    })

    return { result: 'all done' }
  },
})
```

1. Run with the error uncommented — step 1 succeeds, step 2 fails
2. Comment out the error, retrigger the run — a fresh run (new ID) starts with the same input

## Next Steps

- **[Core Concepts](/guide/concepts)** — Understand jobs, steps, runs, and resumability
- **[Server Mode](/guide/server-mode)** — Batch processing with events, cron, and CLI
- **[Fullstack Mode](/guide/fullstack-mode)** — Add a React UI with real-time progress
- **[SPA Mode](/guide/spa-mode)** — Run entirely in the browser
