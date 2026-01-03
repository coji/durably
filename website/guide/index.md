# What is Durably?

Durably is a **resumable job execution** library for TypeScript. Split long-running tasks into steps — if interrupted, resume from the last successful step.

## The Problem

Long-running tasks fail. Networks drop, servers restart, browsers close. Traditional approaches either:

- **Lose all progress** and restart from scratch
- **Require complex infrastructure** like Redis queues or cloud services

## The Solution

Durably saves each step's result to SQLite. On resume, completed steps return cached results instantly.

![Resumability](/images/resumability.svg)

```ts
const job = defineJob({
  name: 'import-csv',
  run: async (step, payload) => {
    // Step 1: Parse (cached after first run)
    const rows = await step.run('parse', () => parseCSV(payload.file))

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

## Where It Runs

| Environment | Storage | Use Case |
|-------------|---------|----------|
| **Node.js** | libsql/better-sqlite3 | Server-side batch jobs |
| **Browser** | SQLite WASM + OPFS | Offline-capable apps |

Same job definition works in both environments.

## Next Step

**[Getting Started →](/guide/getting-started)** — Build a CSV importer with progress UI in 5 minutes.
