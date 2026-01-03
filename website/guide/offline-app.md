# Offline App (Browser-Only)

Run Durably entirely in the browser. Jobs execute locally using SQLite WASM with OPFS persistence. Works offline, survives tab closes.

**Example code:** [browser-vite-react](https://github.com/coji/durably/tree/main/examples/browser-vite-react)

## When to Use

- Offline-capable applications
- Local-first apps (data stays on device)
- Prototyping without backend

## Requirements

### Secure Context

Requires HTTPS or localhost for OPFS access.

### COOP/COEP Headers

SQLite WASM needs cross-origin isolation:

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

## Installation

```bash
npm install @coji/durably @coji/durably-react kysely zod sqlocal
```

## Setup

### Database

```ts
// lib/database.ts
import { SQLocalKysely } from 'sqlocal/kysely'

export const sqlocal = new SQLocalKysely('app.sqlite3')
```

### Job Definition

```ts
// jobs/data-sync.ts
import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const dataSyncJob = defineJob({
  name: 'data-sync',
  input: z.object({ userId: z.string() }),
  output: z.object({ synced: z.number(), failed: z.number() }),
  run: async (step, payload) => {
    step.log.info(`Starting sync for user: ${payload.userId}`)

    const items = await step.run('fetch-local', async () => {
      step.progress(1, 4, 'Fetching local data...')
      await delay(300)
      return Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        data: `Data for ${payload.userId}`,
      }))
    })

    let synced = 0
    let failed = 0

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const success = await step.run(`sync-item-${item.id}`, async () => {
        step.progress(2 + Math.floor(i / 5), 4, `Syncing item ${i + 1}...`)
        await delay(100)
        return Math.random() > 0.1 // 90% success rate
      })

      if (success) {
        synced++
      } else {
        failed++
        step.log.warn(`Failed to sync item: ${item.id}`)
      }
    }

    await step.run('finalize', async () => {
      step.progress(4, 4, 'Finalizing...')
      await delay(200)
    })

    step.log.info(`Sync complete: ${synced} synced, ${failed} failed`)

    return { synced, failed }
  },
})
```

### Durably Instance

```ts
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { dataSyncJob } from '../jobs/data-sync'
import { sqlocal } from './database'

const durably = createDurably({
  dialect: sqlocal.dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}).register({
  dataSync: dataSyncJob,
})

await durably.init()

export { durably }
```

## Usage

```tsx
// App.tsx
import { DurablyProvider, useDurably } from '@coji/durably-react'
import { useJob } from '@coji/durably-react'
import { useState } from 'react'
import { durably } from './lib/durably'
import { dataSyncJob } from './jobs/data-sync'

function SyncButton() {
  const { isReady } = useDurably()
  const [runId, setRunId] = useState<string | null>(null)

  const handleSync = async () => {
    const run = await durably.jobs.dataSync.trigger({ userId: 'user_123' })
    setRunId(run.id)
  }

  const { status, progress, output, isRunning, isCompleted, error } =
    useJob(dataSyncJob, { initialRunId: runId ?? undefined })

  return (
    <div>
      <button onClick={handleSync} disabled={!isReady || isRunning}>
        {isRunning ? 'Syncing...' : 'Sync Data'}
      </button>

      {progress && <p>{progress.current}/{progress.total} - {progress.message}</p>}
      {isCompleted && <p>Synced {output?.synced}, failed {output?.failed}</p>}
      {error && <p>Error: {error}</p>}
    </div>
  )
}

function Loading() {
  return <div>Loading...</div>
}

export function App() {
  return (
    <DurablyProvider durably={durably} fallback={<Loading />}>
      <SyncButton />
    </DurablyProvider>
  )
}
```

## Hook Options

```tsx
const { trigger, ... } = useJob(dataSyncJob, {
  initialRunId: 'run_123',  // Resume existing run
  maxLogs: 100,             // Limit log entries
})
```

## Available Hooks

| Hook | Description |
|------|-------------|
| `useJob(jobDef)` | Trigger and monitor a job |
| `useJobRun({ runId })` | Subscribe to an existing run |
| `useJobLogs({ runId })` | Subscribe to logs |
| `useRuns()` | List runs with pagination |
| `useDurably()` | Access Durably instance |

## Limitations

- **Single tab** — OPFS exclusive access
- **Storage quotas** — Browser limits apply
- **No background** — Jobs only run when tab is active

## Tab Suspension

Browsers suspend inactive tabs. Durably handles this:

1. Tab inactive → heartbeat stops → job marked stale
2. Tab active → worker restarts → job resumes

## Next Steps

- [CSV Import](/guide/csv-import) — Full-stack with server
- [API Reference](/api/durably-react/) — All hooks and options
