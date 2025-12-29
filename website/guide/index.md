# What is Durably?

Durably is a **resumable job execution** library for Node.js and browsers. Split long-running tasks into steps, and if interrupted, resume from the last successful step.

## Use Cases

### Long-Running Jobs with Progress UI

Execute jobs on the server and show real-time progress in your React app via SSE.

```tsx
const { trigger, progress, isRunning } = useJob({
  api: '/api/durably',
  jobName: 'sync-data',
})

// Progress: 50/100
```

[Full-Stack Guide →](/guide/full-stack)

### Data Sync & Batch Processing

Fetch data from APIs, transform, and save. If the process fails midway, it resumes from where it left off.

```ts
const syncJob = defineJob({
  name: 'sync-users',
  run: async (step, payload) => {
    // Step 1: Fetch (persisted after completion)
    const users = await step.run('fetch', () => api.getUsers())

    // Step 2: Save (skipped if already done)
    await step.run('save', () => db.saveUsers(users))
  },
})
```

[Server Guide →](/guide/server)

### Offline-Capable Apps

Run Durably entirely in the browser with SQLite WASM. Works offline, survives tab closes.

```tsx
<DurablyProvider dialectFactory={() => new SQLocalKysely('app.db').dialect}>
  <App />
</DurablyProvider>
```

[Browser-Only Guide →](/guide/browser-only)

## How It Works

Each `step.run()` persists its result to SQLite. On resume, completed steps return their cached results instantly.

```ts
// First run: executes all steps
// Second run (after crash): step 1 returns cached result, step 2 executes

const result = await step.run('expensive-api-call', async () => {
  return await fetch('/api/data').then((r) => r.json())
})
```

## Features

- **Step-level persistence** - Each step is a checkpoint
- **Automatic resumption** - Resume from last successful step
- **Cross-platform** - Node.js and browsers
- **TypeScript** - Full type safety with Zod schemas
- **Minimal dependencies** - Just Kysely and Zod

## Next Steps

- [Getting Started](/guide/getting-started) - Install and run your first job
- [Jobs and Steps](/guide/jobs-and-steps) - Core concepts
- [Live Demo](https://durably-demo.vercel.app) - Try it in your browser
