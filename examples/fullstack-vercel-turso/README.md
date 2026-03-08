# Fullstack Vercel + Turso Example

Durably fullstack example deployed on Vercel with Turso (libSQL) as the database.

## Architecture

- **Framework**: React Router v7 with `@vercel/react-router` preset
- **Database**: Turso (remote libSQL) in production, local libsqld via Docker in development
- **Worker**: Dual-mode
  - **Real-time**: `onRequest` lazily starts the worker — runs during SSE streaming
  - **Background**: `/api/worker` endpoint called by Vercel Cron every minute

## How it works

```
User triggers job → POST /api/durably/trigger
                  ↓
User subscribes   → GET /api/durably/subscribe?runId=xxx (SSE)
                  ↓
onRequest         → durably.init() starts worker during SSE connection
                  ↓
Worker processes  → steps stream via SSE in real-time
                  ↓
SSE disconnects   → function terminates, worker stops
                  ↓
Vercel Cron       → POST /api/worker processes any remaining pending jobs
```

## Setup

### Local development

Requires Docker for the local libsqld instance.

```bash
cp .env.example .env
pnpm install
pnpm dev
```

This starts a local libsqld container (Docker) and the dev server.
The app connects to `http://localhost:8080` — same HTTP protocol as production Turso.

### Production (Vercel + Turso)

1. Create a Turso database:

   ```bash
   turso db create my-durably-app
   turso db tokens create my-durably-app
   ```

2. Set environment variables in Vercel:
   - `TURSO_DATABASE_URL` — `libsql://my-durably-app-<user>.turso.io`
   - `TURSO_AUTH_TOKEN` — token from step 1
   - `CRON_SECRET` — any random string to authenticate cron requests

3. Deploy:
   ```bash
   vercel
   ```

## Key files

| File                          | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `docker-compose.yml`          | Local libsqld for development               |
| `app/lib/database.server.ts`  | Turso/libSQL connection config              |
| `app/lib/durably.server.ts`   | Durably instance with `onRequest` lazy init |
| `app/lib/durably.ts`          | Type-safe client for React components       |
| `app/routes/api.durably.$.ts` | Durably HTTP/SSE handler (splat route)      |
| `app/routes/api.worker.ts`    | Background worker endpoint for Vercel Cron  |
| `vercel.json`                 | Cron schedule (every minute)                |
| `react-router.config.ts`      | Vercel preset configuration                 |
