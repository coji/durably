# Fullstack Example (React Router)

Full-stack React Router application with Durably for server-side job processing. Uses libSQL for storage with server-side rendering and data loading.

This is a public demo: its job API and form actions deliberately have no login. Run it with synthetic data. Before using it for private data or multiple users, authenticate and authorize both the `/api/durably/*` handler and the server actions that trigger jobs. Scope run lists and global SSE with `scopeRuns` and `scopeRunsSubscribe`; bind ownership labels and concurrency keys to the authenticated user or tenant. See the [authentication](../../website/guide/auth.md) and [multi-tenant](../../website/guide/multi-tenant.md) guides.

## Getting Started

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open http://localhost:5173

## Building for Production

```bash
pnpm build
```

## Docker Deployment

```bash
docker build -t my-app .
docker run -p 3000:3000 my-app
```

## Standalone Use

To use this example outside the monorepo, remove the `workspace:*` dependencies and install from npm:

```bash
pnpm add @coji/durably @coji/durably-react
```

## What It Demonstrates

- Server-side Durably with React Router data loading/mutations
- Job triggering via API routes
- Real-time progress updates in the UI
- TypeScript and TailwindCSS
