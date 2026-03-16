# durably

Steps that survive crashes. SQLite to PostgreSQL.

**[Documentation](https://coji.github.io/durably/)** | **[Live Demo](https://durably-demo.vercel.app)**

## Packages

| Package                                         | Description                                               |
| ----------------------------------------------- | --------------------------------------------------------- |
| [@coji/durably](./packages/durably)             | Core library - job definitions, steps, and persistence    |
| [@coji/durably-react](./packages/durably-react) | React bindings - hooks for triggering and monitoring jobs |

## Features

- **Resumable** — each step's result is persisted; interrupted jobs resume from the last successful step
- **Flexible storage** — libSQL/Turso, PostgreSQL, better-sqlite3, or browser OPFS
- **Browser + server** — same API for Node.js and browsers
- **Lease-based recovery** — stale workers are automatically reclaimed via fencing tokens
- **Auto cleanup** — `retainRuns` option purges old completed runs automatically
- **React hooks** — real-time progress via SSE, fullstack and SPA modes
- **Type-safe** — Zod schemas for input/output, labels, and auth context

## Quick Start

```bash
pnpm add @coji/durably kysely zod @libsql/client @libsql/kysely-libsql
```

See the [Quick Start](https://coji.github.io/durably/guide/quick-start) guide, or [Choosing a Database](https://coji.github.io/durably/guide/databases) for PostgreSQL and other backends.

## License

MIT
