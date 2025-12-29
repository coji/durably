# API Reference

This section provides detailed API documentation for Durably.

## Core API (@coji/durably)

| Export | Description |
|--------|-------------|
| [`createDurably`](/api/create-durably) | Create a Durably instance |
| [`defineJob`](/api/define-job) | Define a job (standalone function) |
| [`Step`](/api/step) | Step context for job handlers |
| [`Events`](/api/events) | Event types and subscriptions |

## React API (@coji/durably-react)

| Export | Description |
|--------|-------------|
| [`DurablyProvider`](/api/durably-react#durablyprovider) | React context provider |
| [`useJob`](/api/durably-react#usejob) | Trigger and monitor a job |
| [`useJobRun`](/api/durably-react#usejobrun) | Subscribe to an existing run |
| [`useJobLogs`](/api/durably-react#usejoblogs) | Subscribe to logs from a run |
| [`useDurably`](/api/durably-react#usedurably) | Access Durably instance directly |

See the [durably-react API reference](/api/durably-react) for detailed documentation.

## Quick Reference

### Creating an Instance

```ts
import { createDurably, defineJob } from '@coji/durably'

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
const job = durably.register(jobDef)  // Register a job definition
await durably.retry(runId)            // Retry a failed run

// Events
const unsub = durably.on(event, handler)
```

### Defining and Registering Jobs

```ts
import { defineJob } from '@coji/durably'

// Define a job
const myJobDef = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (step, payload) => {
    const result = await step.run('step-name', async () => {
      return value
    })
    return { result }
  },
})

// Register with durably instance
const myJob = durably.register(myJobDef)

// Trigger a new run
await myJob.trigger(input, options?)
```

### Step Methods

```ts
defineJob({
  name: 'example',
  input: z.object({}),
  run: async (step, payload) => {
    // Execute a step
    const result = await step.run('step-name', async () => {
      return value
    })

    // Log a message
    step.log.info('message', { data })
  },
})
```

## Type Exports

```ts
import type {
  Durably,
  DurablyOptions,
  JobDefinition,
  JobHandle,
  StepContext,
  TriggerOptions,
  RunStatus,
  StepStatus,
} from '@coji/durably'
```
