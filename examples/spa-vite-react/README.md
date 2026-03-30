# Browser-Only SPA Example (Vite + React)

This example demonstrates Durably running entirely in the browser using Vite and React. No server required — all data is stored in the browser via SQLite WASM with OPFS.

## Getting Started

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open http://localhost:5173

## Requirements

### COOP/COEP Headers

SQLite WASM requires cross-origin isolation. This is configured in `vite.config.ts`:

```http
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

### Secure Context

OPFS requires HTTPS or localhost.

## Standalone Use

To use this example outside the monorepo, replace `workspace:*` in `package.json`:

```json
"@coji/durably": "^0.15.0",
"@coji/durably-react": "^0.15.0"
```

Then install with your preferred package manager.

## What It Demonstrates

- `DurablyProvider` for React context management
- `useJob()` hook for triggering and monitoring jobs
- SQLite WASM + OPFS for persistent browser storage
- Multiple job types (image processing, data sync)
- Run history dashboard with retrigger/cancel/delete
- Page reload resilience — jobs resume automatically
