# Browser

This guide covers using Durably in browser environments.

## Requirements

### Secure Context

Durably requires a [Secure Context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS or localhost) for OPFS access.

### COOP/COEP Headers

SQLite WASM requires cross-origin isolation:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

#### Vite Configuration

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

## SQLite Setup

Using [SQLocal](https://sqlocal.dev/) with OPFS:

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect, deleteDatabaseFile } = new SQLocalKysely('app.sqlite3')

const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})
```

## Browser-Specific Configuration

Lower intervals for responsive UI:

```ts
const durably = createDurably({
  dialect,
  pollingInterval: 100,     // Check every 100ms
  heartbeatInterval: 500,   // Heartbeat every 500ms
  staleThreshold: 3000,     // Stale after 3 seconds
})
```

## React Integration

For React-specific patterns including hooks, StrictMode compatibility, and state management, see the dedicated [React guide](/guide/react).

## Tab Suspension

Browsers can suspend inactive tabs. Durably handles this:

1. Tab becomes inactive → heartbeat stops
2. Job is marked stale after `staleThreshold`
3. Tab becomes active → worker restarts
4. Stale job is picked up and resumed

### Testing Resumption

1. Start a job
2. Reload the page mid-execution
3. The job resumes from the last completed step

## Database Management

### Reset Database

```ts
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect, deleteDatabaseFile } = new SQLocalKysely('app.sqlite3')

// To reset:
await durably.stop()
await deleteDatabaseFile()
location.reload()
```

### Database Size

OPFS has storage limits. Monitor usage:

```ts
const estimate = await navigator.storage.estimate()
console.log(`Used: ${estimate.usage} / ${estimate.quota}`)
```

## Limitations

1. **Single tab**: OPFS has exclusive access - only one tab can use the database
2. **No SharedWorker**: Workers must be in the same tab
3. **Storage limits**: Browser storage quotas apply
4. **No background sync**: Jobs only run when the tab is active
