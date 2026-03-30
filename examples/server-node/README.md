# Server Node.js Example (libSQL/Turso)

Minimal Node.js example using Durably with libSQL (Turso-compatible) as the storage backend.

## Getting Started

```bash
# Install dependencies
pnpm install

# Run the example
pnpm dev
```

This runs `basic.ts`, which initializes Durably, triggers a job, and displays run statistics.

## Standalone Use

To use this example outside the monorepo, replace `workspace:*` in `package.json`:

```json
"@coji/durably": "^0.15.0"
```

Then install with your preferred package manager.

## What It Demonstrates

- Creating a Durably instance with libSQL dialect
- Defining and registering jobs with `defineJob()`
- Triggering jobs with `triggerAndWait()`
- Subscribing to run and step events
- Querying run statistics via Kysely
