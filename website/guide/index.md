# What is Durably?

Durably is a step-oriented batch execution framework that enables **resumable workflows** in both Node.js and browsers.

## The Problem

When running batch jobs or workflows, failures can happen at any point:
- Network errors during API calls
- Process crashes
- Browser tab closures
- Server restarts

Traditional approaches require you to either:
- Re-run the entire job from the beginning
- Implement complex checkpointing logic manually

## The Solution

Durably automatically persists the result of each step to SQLite. If a job is interrupted, it resumes from the last successful step.

```ts
const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({ orgId: z.string() }),
  },
  async (context, payload) => {
    // Step 1: Fetch users (persisted after completion)
    const users = await context.run('fetch-users', async () => {
      return api.fetchUsers(payload.orgId)
    })

    // Step 2: Save to database (skipped if already done)
    await context.run('save-to-db', async () => {
      await db.upsertUsers(users)
    })

    return { syncedCount: users.length }
  },
)
```

## Key Features

- **Step-level persistence**: Each `context.run()` call creates a checkpoint
- **Automatic resumption**: Interrupted jobs resume from the last successful step
- **Cross-platform**: Same code runs in Node.js and browsers
- **Minimal dependencies**: Just Kysely and Zod
- **Type-safe**: Full TypeScript support with schema validation

## When to Use Durably

Durably is ideal for:

- **Data synchronization jobs** - Fetching and processing data from external APIs
- **Batch processing** - Processing large datasets in steps
- **Browser workflows** - Long-running operations that survive page reloads
- **Offline-first applications** - Operations that need to resume after connectivity is restored

## Next Steps

- [Getting Started](/guide/getting-started) - Install and create your first job
- [Jobs and Steps](/guide/jobs-and-steps) - Learn about the core concepts
- [Live Demo](https://durably-demo.vercel.app) - Try it in your browser
