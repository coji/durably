# durably-react

React bindings for Durably - hooks for triggering and monitoring jobs.

## Requirements

- **React 19+** (uses `React.use()` for Promise resolution)

## Installation

```bash
# Browser-complete mode (runs Durably entirely in browser)
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (connects to server via HTTP/SSE)
npm install @coji/durably-react
```

## Two Modes

Durably React provides two distinct modes for different use cases:

### Browser-Complete Mode

Run Durably entirely in the browser using SQLite WASM with OPFS. All job execution happens client-side.

```tsx
import { DurablyProvider, useJob } from '@coji/durably-react'
```

**Use when:**
- Building offline-capable applications
- Local-first apps where data stays on device
- Prototyping without a backend

[Browser-Complete Mode Reference →](./browser)

### Server-Connected Mode

Connect to a Durably server via HTTP/SSE. Jobs execute on the server, with real-time updates streamed to the client.

```tsx
import { createDurablyClient } from '@coji/durably-react/client'
```

**Use when:**
- Building full-stack applications
- Jobs need server-side resources (databases, APIs)
- Sharing job state across multiple clients

[Server-Connected Mode Reference →](./client)

## Quick Comparison

| Feature | Browser-Complete | Server-Connected |
|---------|------------------|------------------|
| Import | `@coji/durably-react` | `@coji/durably-react/client` |
| Job Execution | Client-side | Server-side |
| Persistence | OPFS (browser) | Server database |
| Offline Support | Yes | No |
| Multi-client | No (single tab) | Yes |
| Setup | DurablyProvider | API endpoint |

## Type Definitions

Common types used across both modes.

[Type Definitions →](./types)
