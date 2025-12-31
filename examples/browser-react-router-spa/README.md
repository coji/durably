# Browser-Only SPA Example (React Router v7)

This example demonstrates Durably running entirely in the browser using React Router v7 in SPA mode.

## Features

- **React Router v7 SPA mode** - No server-side rendering, pure client-side app
- **SQLite WASM with OPFS** - Persistent storage in the browser
- **DurablyProvider** - React context for lifecycle management
- **Multiple jobs** - Image processing and data sync examples
- **Run history dashboard** - View, retry, cancel, and delete runs
- **Tailwind CSS** - Modern styling

## Getting Started

```bash
# Install dependencies
pnpm install

# Start development server (generates types automatically)
pnpm dev
```

Open http://localhost:5173

> **Note:** Run `pnpm dev` at least once before `pnpm typecheck` to generate React Router type definitions.

## Requirements

### COOP/COEP Headers

SQLite WASM requires cross-origin isolation. This is configured in `vite.config.ts`:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

### Secure Context

Browser-only mode requires HTTPS or localhost for OPFS access.

## Project Structure

```
app/
├── root.tsx           # DurablyProvider setup with SQLocalKysely
├── lib/
│   └── jobs.ts        # Job definitions (processImageJob, dataSyncJob)
└── routes/
    └── _index.tsx     # Main page with job panels
    └── _index/
        └── dashboard.tsx  # Run history component
```

## Key Differences from Fullstack Mode

| Aspect | Browser-Only (SPA) | Fullstack (SSR) |
|--------|-------------------|-----------------|
| Database | SQLite WASM + OPFS | libsql/better-sqlite3 |
| Provider | `DurablyProvider` | No provider needed |
| Hooks | `useJob(jobDefinition)` | `durably.jobName.useJob()` |
| Data | Stays in browser | Server-side storage |
| Offline | Works offline | Requires server |

## Try It

1. Run a job and observe the progress
2. Reload the page during execution - it resumes automatically
3. Check the dashboard for run history
4. Try retry/cancel/delete actions
