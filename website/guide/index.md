# What is Durably?

Durably is a **resumable job execution** library for TypeScript. Split long-running tasks into steps — if interrupted, resume from the last successful step.

## The Problem

Long-running tasks fail. Networks drop, servers restart, browsers close. Traditional approaches either:

- **Lose all progress** and restart from scratch
- **Require complex infrastructure** like Redis queues or cloud services

## The Solution

Durably saves each step's result to SQLite. On resume, completed steps return cached results instantly.

```ts
const job = defineJob({
  name: 'import-csv',
  run: async (step, input) => {
    // Step 1: Parse (cached after first run)
    const rows = await step.run('parse', () => parseCSV(input.file))

    // Step 2: Import each row
    for (const [i, row] of rows.entries()) {
      await step.run(`import-${i}`, () => db.insert(row))
      step.progress(i + 1, rows.length)
    }

    return { count: rows.length }
  },
})
```

If the process crashes after importing 500 of 1000 rows, restart picks up at row 501.

## Three Ways to Run

| Mode          | Storage                        | Use Case                             |
| ------------- | ------------------------------ | ------------------------------------ |
| **Server**    | @libsql/client, better-sqlite3 | Cron jobs, data pipelines, CLI tools |
| **Fullstack** | Server DB + SSE to browser     | Web apps with real-time progress UI  |
| **SPA**       | SQLite WASM + OPFS             | Offline-capable, local-first apps    |

Same job definition works in all three modes.

## Next Step

**[Quick Start](/guide/quick-start)** — Run your first resumable job in under 2 minutes.
