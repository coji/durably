# What is Durably?

Durably is a **resumable job execution** library for Node.js and browsers. Split long-running tasks into steps, and if interrupted, resume from the last successful step.

## Use Cases

### Long-Running Jobs with Progress UI

Import a CSV with thousands of rows and show real-time progress in your React app via SSE.

```tsx
const { trigger, progress, isRunning } = useJob({
  api: '/api/durably',
  jobName: 'import-csv',
})

// Progress: 500/1000 rows
```

[Full-Stack Guide →](/guide/full-stack)

### Data Sync & Batch Processing

Fetch data from APIs, transform, and save. If the process fails midway, it resumes from where it left off.

```ts
const importJob = defineJob({
  name: 'import-csv',
  run: async (step, payload) => {
    // Step 1: Parse CSV (persisted after completion)
    const rows = await step.run('parse', () => parseCSV(payload.csv))

    // Step 2: Import (skipped if already done)
    for (const [i, row] of rows.entries()) {
      await step.run(`import-${i}`, () => db.insert(row))
    }
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
