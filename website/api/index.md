# API Reference

This section provides detailed API documentation for Durably.

## Core API

| Export | Description |
|--------|-------------|
| [`createDurably`](/api/create-durably) | Create a Durably instance |
| [`defineJob`](/api/define-job) | Define a job (via instance) |
| [`Context`](/api/context) | Job execution context |
| [`Events`](/api/events) | Event types and subscriptions |

## Quick Reference

### Creating an Instance

```ts
import { createDurably } from '@coji/durably'

const durably = createDurably({
  dialect,                    // Kysely SQLite dialect
  pollingInterval: 1000,      // Worker polling interval (ms)
  heartbeatInterval: 5000,    // Heartbeat update interval (ms)
  staleThreshold: 30000,      // Time until job is considered stale (ms)
})
```

### Instance Methods

```ts
// Lifecycle
await durably.migrate()       // Run database migrations
durably.start()               // Start the worker
await durably.stop()          // Stop the worker gracefully

// Job management
const job = durably.defineJob(options, handler)
await durably.retry(runId)    // Retry a failed run

// Events
const unsub = durably.on(event, handler)
```

### Job Methods

```ts
const job = durably.defineJob(...)

// Trigger a new run
await job.trigger(input, options?)
```

### Context Methods

```ts
durably.defineJob(..., async (context, payload) => {
  // Execute a step
  const result = await context.run('step-name', async () => {
    return value
  })

  // Log a message
  context.log('info', 'message', { data })
})
```

## Type Exports

```ts
import type {
  Durably,
  DurablyOptions,
  Job,
  JobOptions,
  Context,
  TriggerOptions,
  RunStatus,
  StepStatus,
} from '@coji/durably'
```
