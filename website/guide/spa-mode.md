# SPA Mode

Run Durably entirely in the browser. Jobs execute locally using SQLite WASM with OPFS persistence. Works offline, survives tab closes.

**Example code:** [spa-vite-react](https://github.com/coji/durably/tree/main/examples/spa-vite-react)

## When to Use

- Offline-capable applications
- Local-first apps (data stays on the user's device)
- Prototyping without a backend
- Single-user, single-tab usage

## Requirements

- **HTTPS or localhost** (OPFS requires Secure Context)
- **Cross-origin isolation headers** (SQLite WASM uses SharedArrayBuffer)

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    {
      name: 'coop-coep',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],
  optimizeDeps: { exclude: ['sqlocal'] },
})
```

## Install

```bash
pnpm add @coji/durably @coji/durably-react kysely zod sqlocal
```

## Project Structure

```txt
src/
├── jobs/
│   └── data-sync.ts        # Job definition
├── lib/
│   ├── database.ts         # SQLocal dialect
│   └── durably.ts          # Durably instance
└── App.tsx                 # UI
```

## Step 1: Database

```ts
// lib/database.ts
import { SQLocalKysely } from 'sqlocal/kysely'

export const sqlocal = new SQLocalKysely('app.sqlite3')
```

The database file is stored in the browser's Origin Private File System — persistent across page reloads.

## Step 2: Define a Job

```ts
// jobs/data-sync.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const dataSyncJob = defineJob({
  name: 'data-sync',
  input: z.object({ userId: z.string() }),
  output: z.object({ synced: z.number(), failed: z.number() }),
  run: async (step, input) => {
    step.log.info(`Starting sync for user: ${input.userId}`)

    const items = await step.run('fetch-local', async () => {
      step.progress(1, 3, 'Fetching local data...')
      await delay(300)
      return Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}` }))
    })

    let synced = 0
    let failed = 0

    for (let i = 0; i < items.length; i++) {
      const ok = await step.run(`sync-${items[i].id}`, async () => {
        step.progress(2, 3, `Syncing item ${i + 1}/${items.length}...`)
        await delay(100)
        return Math.random() > 0.1
      })
      ok ? synced++ : failed++
    }

    await step.run('finalize', async () => {
      step.progress(3, 3, 'Finalizing...')
      await delay(200)
    })

    return { synced, failed }
  },
})
```

## Step 3: Durably Instance

```ts
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { dataSyncJob } from '../jobs/data-sync'
import { sqlocal } from './database'

const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingIntervalMs: 100,
  jobs: { dataSync: dataSyncJob },
})

await durably.init()

export { durably }
```

## Step 4: Build the UI

Wrap your app with `DurablyProvider`, then use hooks from `@coji/durably-react/spa`:

```tsx
// App.tsx
import { DurablyProvider, useJob, useRuns } from '@coji/durably-react/spa'
import { durably } from './lib/durably'
import { dataSyncJob } from './jobs/data-sync'

function SyncButton() {
  const {
    trigger,
    status,
    progress,
    output,
    isLeased,
    isCompleted,
    isFailed,
    error,
  } = useJob(dataSyncJob)

  return (
    <div>
      <button
        onClick={() => trigger({ userId: 'user_123' })}
        disabled={isLeased}
      >
        {isLeased ? 'Syncing...' : 'Sync Data'}
      </button>

      {isLeased && progress && (
        <div>
          <progress value={progress.current} max={progress.total} />
          <p>{progress.message}</p>
        </div>
      )}
      {isCompleted && (
        <p>
          Synced {output?.synced}, failed {output?.failed}
        </p>
      )}
      {isFailed && <p>Error: {error}</p>}
    </div>
  )
}

function RunHistory() {
  const { runs } = useRuns({ pageSize: 5 })

  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id}>
          {run.jobName}: {run.status}
        </li>
      ))}
    </ul>
  )
}

export function App() {
  return (
    <DurablyProvider durably={durably} fallback={<p>Loading database...</p>}>
      <SyncButton />
      <RunHistory />
    </DurablyProvider>
  )
}
```

## SPA vs Fullstack Hooks

SPA hooks use the Durably instance directly (via `DurablyProvider`). Fullstack hooks connect via HTTP/SSE.

| SPA (`@coji/durably-react/spa`) | Fullstack (`@coji/durably-react`)      |
| ------------------------------- | -------------------------------------- |
| `useJob(jobDefinition)`         | `durablyClient.importCsv.useJob()`     |
| `useRuns()`                     | `durablyClient.useRuns()`              |
| Needs `DurablyProvider`         | Needs `createDurably<typeof server>()` |
| Jobs run in the browser         | Jobs run on the server                 |

## Limitations

- **Single tab** — OPFS has exclusive access per origin
- **Storage quotas** — Browser limits apply (~10% of disk)
- **No background execution** — Jobs only run while the tab is active

## Tab Suspension

Browsers suspend inactive tabs. Durably handles this automatically:

1. Tab goes inactive → lease renewal stops → lease expires
2. Tab becomes active → worker restarts → job resumes from last checkpoint

## Next Steps

- **[Fullstack Mode](/guide/fullstack-mode)** — Move jobs to the server
- **[Error Handling & Retry](/guide/error-handling)** — Handle failures gracefully
- **[API Reference](/api/durably-react/spa)** — All SPA hooks and options
