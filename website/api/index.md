# API Reference

Complete API documentation for Durably.

## Core API (@coji/durably)

| Export | Description |
|--------|-------------|
| [`createDurably`](/api/create-durably) | Create a Durably instance |
| [`defineJob`](/api/define-job) | Define a job with type-safe schema |
| [`Step`](/api/step) | Step context for job handlers |
| [`Events`](/api/events) | Event types and subscriptions |

## React API (@coji/durably-react)

### Browser-Complete Mode

| Export | Description |
|--------|-------------|
| [`DurablyProvider`](/api/durably-react/browser#durablyprovider) | React context provider |
| [`useDurably`](/api/durably-react/browser#usedurably) | Access Durably instance directly |
| [`useJob`](/api/durably-react/browser#usejob) | Trigger and monitor a job |
| [`useJobRun`](/api/durably-react/browser#usejobrun) | Subscribe to an existing run |
| [`useJobLogs`](/api/durably-react/browser#usejoblogs) | Subscribe to logs from a run |
| [`useRuns`](/api/durably-react/browser#useruns) | List runs with filtering |

### Server-Connected Mode (@coji/durably-react/client)

| Export | Description |
|--------|-------------|
| [`createDurablyClient`](/api/durably-react/client#createdurablyclient) | Type-safe client for server mode |
| [`useJob`](/api/durably-react/client#usejob) | Trigger job via HTTP |
| [`useJobRun`](/api/durably-react/client#usejobrun) | Subscribe to run via SSE |
| [`useJobLogs`](/api/durably-react/client#usejoblogs) | Subscribe to logs via SSE |
| [`useRuns`](/api/durably-react/client#useruns) | List and paginate runs |
| [`useRunActions`](/api/durably-react/client#userunactions) | Run actions (cancel, retry, delete) |

[Full React API Reference →](/api/durably-react/)

## Server API (@coji/durably)

| Export | Description |
|--------|-------------|
| [`createDurablyHandler`](/api/create-durably#createdurablyhandler) | Create HTTP handlers for Durably |

## Quick Start

### Installation

```bash
# Core package
npm install @coji/durably kysely zod

# React bindings (optional)
npm install @coji/durably-react

# SQLite driver (choose one)
npm install @libsql/kysely-libsql   # Server (libSQL/Turso)
npm install sqlocal                  # Browser (OPFS)
```

### Basic Setup

```ts
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createClient } from '@libsql/client'
import { z } from 'zod'

// 1. Create SQLite dialect
const client = createClient({ url: 'file:local.db' })
const dialect = new LibsqlDialect({ client })

// 2. Define job
const processDataJob = defineJob({
  name: 'process-data',
  input: z.object({ items: z.array(z.string()) }),
  output: z.object({ count: z.number() }),
  run: async (step, payload) => {
    for (let i = 0; i < payload.items.length; i++) {
      await step.run(`process-${i}`, async () => {
        // Process item
      })
      step.progress(i + 1, payload.items.length)
    }
    return { count: payload.items.length }
  },
})

// 3. Create Durably instance with registered jobs
const durably = createDurably({ dialect }).register({
  processData: processDataJob,
})

// 4. Initialize and start
await durably.migrate()
durably.start()

// 5. Trigger a job
const run = await durably.jobs.processData.trigger({ items: ['a', 'b', 'c'] })
console.log('Run ID:', run.id)
```

## Type Exports

```ts
import type {
  // Core
  Durably,
  DurablyOptions,
  DurablyPlugin,

  // Job
  JobDefinition,
  JobHandle,
  JobInput,
  JobOutput,

  // Step
  StepContext,

  // Run
  Run,
  RunFilter,
  RunStatus,
  TriggerOptions,
  TriggerAndWaitResult,

  // Events
  DurablyEvent,
  EventType,
  EventListener,
  Unsubscribe,
  ErrorHandler,
  RunStartEvent,
  RunCompleteEvent,
  RunFailEvent,
  RunProgressEvent,
  StepStartEvent,
  StepCompleteEvent,
  StepFailEvent,
  LogWriteEvent,
  WorkerErrorEvent,

  // Server
  DurablyHandler,
  TriggerRequest,
  TriggerResponse,

  // Database (advanced)
  Database,
  RunsTable,
  StepsTable,
  LogsTable,
} from '@coji/durably'
```
