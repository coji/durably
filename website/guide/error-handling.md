# Error Handling & Retry

Durably doesn't auto-retry failures. This is intentional — you decide what to do when something goes wrong.

## How Failures Work

When a step throws an error, the run is marked `failed` immediately. Completed steps keep their cached results.

```ts
run: async (step) => {
  await step.run('step-1', () => 'ok') // Saved
  await step.run('step-2', () => {
    throw new Error('boom')
  }) // Run fails here
  await step.run('step-3', () => 'never') // Never reached
}
```

After retry, step-1 returns its cached result and step-2 runs again.

## Retry Patterns

### Server-Side Retry

```ts
// Check and retry a failed run
const run = await durably.getRun(runId)
if (run?.status === 'failed') {
  await durably.retry(runId) // Resets to pending, worker picks it up
}
```

### Fullstack Retry (React)

```tsx
import { durablyClient } from '~/lib/durably'

function FailedRunActions({ runId }: { runId: string }) {
  const { retry, cancel } = durablyClient.useRunActions()
  const { status, error } = durablyClient.importCsv.useRun(runId)

  if (status === 'failed') {
    return (
      <div>
        <p>Failed: {error}</p>
        <button onClick={() => retry(runId)}>Retry</button>
      </div>
    )
  }

  if (status === 'running') {
    return <button onClick={() => cancel(runId)}>Cancel</button>
  }

  return null
}
```

### SPA Retry

In SPA mode, trigger the same job again — Durably doesn't expose a direct `retry()` in the browser hooks.

```tsx
import { useJob } from '@coji/durably-react/spa'

function RetryableJob() {
  const { trigger, isFailed, error, reset } = useJob(myJob)

  if (isFailed) {
    return (
      <div>
        <p>Failed: {error}</p>
        <button onClick={() => { reset(); trigger({ ... }) }}>
          Try Again
        </button>
      </div>
    )
  }

  return <button onClick={() => trigger({ ... })}>Run</button>
}
```

## Designing Resilient Steps

### Make Steps Idempotent

Steps may re-execute after a crash. Use upserts and idempotency keys:

```ts
// Good: upsert instead of insert
await step.run('save-user', () => db.upsert(user))

// Good: idempotency key with external APIs
await step.run('charge', () =>
  stripe.charges.create({
    amount: 1000,
    idempotency_key: `order_${orderId}`,
  }),
)

// Bad: duplicate insert on retry
await step.run('save-user', () => db.insert(user))
```

### Keep Steps Small

Smaller steps = less work to redo on failure:

```ts
// Bad: one step for everything
await step.run('import-all', async () => {
  for (const row of rows) await db.insert(row)
})

// Good: batch checkpoints
for (let i = 0; i < rows.length; i += 100) {
  await step.run(`batch-${i}`, async () => {
    for (const row of rows.slice(i, i + 100)) {
      await db.insert(row)
    }
  })
}
```

### Handle Partial Failures

Use step results to track what succeeded:

```ts
run: async (step, input) => {
  const results = []

  for (const item of input.items) {
    const result = await step.run(`process-${item.id}`, async () => {
      try {
        await processItem(item)
        return { id: item.id, ok: true }
      } catch (e) {
        step.log.warn(`Failed to process ${item.id}: ${e}`)
        return { id: item.id, ok: false, error: String(e) }
      }
    })
    results.push(result)
  }

  const succeeded = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok).length
  return { succeeded, failed }
}
```

## Preventing Duplicates

Use idempotency keys to ensure a job runs at most once for a given operation:

```ts
// Same key = same run (returns existing if already triggered)
await durably.jobs.importCsv.trigger(
  { filename: 'data.csv' },
  { idempotencyKey: `import-${fileHash}` },
)
```

This is useful for:

- Form double-submit protection
- Webhook deduplication
- Scheduled job deduplication (one per day)

## Cancellation

Cancel a running job. The current step finishes, then the job stops.

```ts
// Server-side
await durably.cancel(runId)

// Fullstack (React)
const { cancel } = durablyClient.useRunActions()
await cancel(runId)
```

## Monitoring Failures

Use events to detect and alert on failures:

```ts
durably.on('run:fail', ({ runId, jobName, error }) => {
  console.error(`Job ${jobName} failed (${runId}): ${error}`)
  // Send to your alerting system
})

durably.on('step:fail', ({ runId, stepName, error }) => {
  console.error(`Step ${stepName} failed in ${runId}: ${error}`)
})
```

## Next Steps

- **[Auth & Multi-Tenant](/guide/auth)** — Protect endpoints and isolate data
- **[Deployment Guide](/guide/deployment)** — Choose the right mode for your app
- **[Events Reference](/api/events)** — All event types
