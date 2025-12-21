# Deployment

Durably requires a long-running process to poll for and execute jobs. This guide covers deployment options and limitations.

## Requirements

Durably workers need:

- **Persistent process**: A process that runs continuously to poll for jobs
- **SQLite access**: Either local file, Turso cloud, or browser OPFS
- **No request timeouts**: Jobs may run for minutes or hours

## Recommended Platforms

### Fly.io

Deploy as a long-running process:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "worker.js"]
```

```toml
# fly.toml
[processes]
  worker = "node worker.js"
```

### Railway

Works out of the box with standard Node.js deployment. Set up a separate worker service or run alongside your web server.

### Docker / VPS

Any environment that supports long-running Node.js processes:

```bash
# PM2
pm2 start worker.js --name durably-worker

# systemd
[Service]
ExecStart=/usr/bin/node /app/worker.js
Restart=always
```

### Render

Use a "Background Worker" service type, not a "Web Service".

## Not Recommended

### Serverless Functions

Durably is **not compatible** with serverless environments:

| Platform | Limitation |
|----------|------------|
| Vercel Functions | 10s-300s timeout |
| Cloudflare Workers | 30s CPU time limit |
| AWS Lambda | 15min max timeout |
| Netlify Functions | 10s-26s timeout |

**Why it doesn't work:**

1. **Polling model**: Durably continuously polls for pending jobs
2. **Long-running jobs**: Steps may take minutes to complete
3. **Cold starts**: Each invocation starts fresh, breaking continuity
4. **Cost**: Constant polling would be expensive on pay-per-invocation models

### Workarounds (Advanced)

If you must use serverless for triggering jobs, you can:

1. **Trigger only**: Use serverless to call `job.trigger()` and store jobs in Turso
2. **Separate worker**: Run the actual worker on a long-running platform

```ts
// Vercel API route - trigger only
export async function POST(req: Request) {
  const payload = await req.json()
  await myJob.trigger(payload) // Just inserts into DB
  return Response.json({ status: 'queued' })
}

// Fly.io worker - processes jobs
durably.start() // Long-running polling
```

## Browser Deployment

For browser-based workers (using SQLite WASM with OPFS):

- Host your static site anywhere (Vercel, Netlify, GitHub Pages)
- The worker runs entirely in the user's browser
- Data persists in OPFS (Origin Private File System)
- Requires HTTPS (Secure Context)

See [Browser Guide](/guide/browser) for details.

## Database Considerations

### Turso (Recommended for Production)

- Hosted SQLite-compatible database
- Works from any platform (including serverless for triggers)
- Built-in replication and backups

### Local SQLite

- Works for single-server deployments
- Use persistent volumes on containerized platforms
- Not suitable for horizontal scaling

## Health Checks

Monitor your worker with events:

```ts
durably.on('run:complete', (event) => {
  metrics.increment('jobs.completed')
})

durably.on('run:fail', (event) => {
  metrics.increment('jobs.failed')
  alerting.notify(event.error)
})
```

## Graceful Shutdown

Always handle shutdown signals:

```ts
process.on('SIGTERM', async () => {
  console.log('Shutting down...')
  await durably.stop()
  process.exit(0)
})
```

This ensures in-progress jobs complete their current step before stopping.
