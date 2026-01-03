# Core Concepts

Deep dive into Durably's architecture and behavior.

## Jobs

Jobs are defined with `defineJob()` and registered with `durably.register()`:

```ts
const myJob = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (step, payload) => {
    // Job implementation
    return { result: 'done' }
  },
})

const { myJob: job } = durably.register({ myJob })
```

| Option | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Unique job identifier |
| `input` | Yes | Zod schema for payload |
| `output` | No | Zod schema for return value |
| `run` | Yes | The job function |

### Job Lifecycle

![Job Lifecycle](/images/job-lifecycle.svg)

## Steps

Steps are checkpoints created with `step.run()`:

```ts
const result = await step.run('step-name', async () => {
  return someValue  // Persisted to SQLite
})
```

**First run:** Executes function, persists result.
**Subsequent runs:** Returns cached result instantly.

### Step Names Must Be Unique

```ts
// Good
await step.run('fetch-user', () => fetchUser())
await step.run('update-profile', () => updateProfile())

// Bad - duplicate names
await step.run('step', () => doA())
await step.run('step', () => doB())  // Returns cached result from doA!
```

### Break Large Operations into Steps

```ts
// Bad - crash loses all progress
await step.run('import-all', async () => {
  for (const row of rows) await db.insert(row)
})

// Good - checkpoint per batch
for (let i = 0; i < rows.length; i += 100) {
  await step.run(`batch-${i}`, async () => {
    for (const row of rows.slice(i, i + 100)) {
      await db.insert(row)
    }
  })
}
```

## Resumability

### How It Works

1. Each `step.run()` saves its result to SQLite
2. If process crashes, restart picks up the job
3. Completed steps return cached results
4. Execution continues from next incomplete step

```ts
// First run
const data = await step.run('fetch', () => api.fetch())  // Runs, saves
await step.run('process', () => process(data))           // Crashes!

// After restart
const data = await step.run('fetch', () => api.fetch())  // Returns cached
await step.run('process', () => process(data))           // Runs
```

### Heartbeat Mechanism

Running jobs send heartbeats to indicate they're alive:

```ts
createDurably({
  dialect,
  heartbeatInterval: 5000,   // Send heartbeat every 5s
  staleThreshold: 30000,     // Mark stale after 30s without heartbeat
})
```

When a job's heartbeat expires, it's reset to `pending` and picked up again.

### Idempotency

Steps may re-run on failure. Design for safe retries:

```ts
// Good: Upsert instead of insert
await step.run('save', () => db.upsert(user))

// Good: Idempotency key with external APIs
await step.run('charge', () =>
  stripe.charges.create({
    amount: 1000,
    idempotency_key: `order_${orderId}`,
  })
)
```

## Trigger Options

### Idempotency Key

Prevent duplicate runs:

```ts
await job.trigger({ id: '123' }, {
  idempotencyKey: 'request-abc'
})
// Same key returns existing run
```

### Concurrency Key

Limit concurrent execution:

```ts
await job.trigger({ userId: '123' }, {
  concurrencyKey: 'user_123'
})
// Only one job per key runs at a time
```

## Events

Monitor job execution:

```ts
durably.on('run:start', ({ runId, jobName }) => { ... })
durably.on('run:progress', ({ runId, progress }) => { ... })
durably.on('run:complete', ({ runId, output }) => { ... })
durably.on('run:fail', ({ runId, error }) => { ... })
durably.on('step:start', ({ runId, stepName }) => { ... })
durably.on('step:complete', ({ runId, stepName, output }) => { ... })
```

See [Events API](/api/events) for the full list.
