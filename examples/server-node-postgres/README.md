# Server Node.js Example (PostgreSQL)

Minimal Node.js example using Durably with PostgreSQL as the storage backend.

## Prerequisites

- PostgreSQL instance running
- `DATABASE_URL` environment variable set

## Getting Started

```bash
# Install dependencies
pnpm install

# Set your PostgreSQL connection string
export DATABASE_URL="postgresql://user:password@localhost:5432/durably"

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

- Creating a Durably instance with PostgreSQL dialect
- Defining and registering jobs with `defineJob()`
- Triggering jobs with `triggerAndWait()`
- Subscribing to run and step events
- Using Durably with an existing PostgreSQL database
