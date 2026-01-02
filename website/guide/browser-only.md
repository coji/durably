# Browser-Only

Run Durably entirely in the browser without a server. Jobs execute in the browser using SQLite WASM with OPFS for persistence.

## When to Use

- Offline-capable applications
- Local-first apps where data stays on the user's device
- Prototyping without backend infrastructure

## Installation

```bash
npm install @coji/durably-react @coji/durably kysely zod sqlocal
```

## Requirements

### Secure Context

Browser-only mode requires a [Secure Context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS or localhost) for OPFS access.

### COOP/COEP Headers

SQLite WASM requires cross-origin isolation:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

**Vite Configuration:**

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    {
      name: 'configure-response-headers',
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
          next()
        })
      },
    },
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['sqlocal'],
  },
})
```

## Usage

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react'
import { createDurably, defineJob } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

// Define job outside component
const syncJobDef = defineJob({
  name: 'sync-data',
  input: z.object({ userId: z.string() }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    const data = await step.run('fetch', () => api.fetch(payload.userId))
    await step.run('save', () => db.save(data))
    return { count: data.length }
  },
})

// Create and configure Durably instance
async function createBrowserDurably() {
  const { dialect } = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({ dialect })
  durably.register({ syncData: syncJobDef })
  await durably.migrate()
  return durably
}

// Create a promise that resolves to the durably instance
const durablyPromise = createBrowserDurably()

function SyncButton() {
  const { trigger, status, output, error, progress, isRunning, isCompleted } =
    useJob(syncJobDef)

  return (
    <div>
      <button
        onClick={() => trigger({ userId: 'user_123' })}
        disabled={isRunning}
      >
        {isRunning ? 'Syncing...' : 'Sync Data'}
      </button>

      {progress && (
        <p>
          Progress: {progress.current}/{progress.total}
        </p>
      )}

      {isCompleted && <p>Synced {output?.count} items</p>}
      {error && <p>Error: {error}</p>}
    </div>
  )
}

function App() {
  return (
    <DurablyProvider durably={durablyPromise} fallback={<p>Loading...</p>}>
      <SyncButton />
    </DurablyProvider>
  )
}
```

## Available Hooks

| Hook | Description |
|------|-------------|
| `useJob` | Trigger and monitor a job with real-time status, progress, and logs |
| `useJobRun` | Subscribe to an existing run by ID |
| `useJobLogs` | Subscribe to logs from a run with optional limit |
| `useDurably` | Access the Durably instance directly |

See the [API Reference](/api/durably-react) for detailed documentation.

## Limitations

- **Single tab**: OPFS has exclusive access - only one tab can use the database
- **Storage limits**: Browser storage quotas apply
- **No background sync**: Jobs only run when the tab is active

## Tab Suspension

Browsers can suspend inactive tabs. Durably handles this automatically:

1. Tab becomes inactive → heartbeat stops
2. Job is marked stale after `staleThreshold`
3. Tab becomes active → worker restarts
4. Stale job is picked up and resumed
