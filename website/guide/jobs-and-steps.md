# Jobs and Steps

## Defining a Job

Jobs are defined using the standalone `defineJob()` function and registered with `durably.register()`:

```ts
import { createDurably, defineJob } from '@coji/durably'
import { z } from 'zod'

// Create durably instance (see Getting Started for dialect setup)
const durably = createDurably({ dialect })

const myJobDef = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (step, payload) => {
    // Job implementation
    return { result: 'done' }
  },
})

// Register to get a job handle
const { myJob } = durably.register({
  myJob: myJobDef,
})
```

### Job Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique job identifier |
| `input` | `ZodSchema` | Yes | Schema for job payload |
| `output` | `ZodSchema` | No | Schema for job return value |
| `run` | `Function` | Yes | The job's run function |

## Creating Steps

Steps are created using `step.run()`:

```ts
const result = await step.run('step-name', async () => {
  // Step logic here
  return someValue
})
```

### Step Behavior

1. **First execution**: The function runs and its return value is persisted
2. **Subsequent executions**: The persisted value is returned without running the function
3. **Type inference**: The return type is inferred from the function

### Step Names

Step names must be unique within a job:

```ts
// Good - unique names
await step.run('fetch-user', async () => { ... })
await step.run('update-profile', async () => { ... })

// Bad - duplicate names will cause issues
await step.run('step', async () => { ... })
await step.run('step', async () => { ... }) // Won't work correctly
```

## Triggering Jobs

### Basic Trigger

```ts
await myJob.trigger({ id: 'abc123' })
```

### With Idempotency Key

Prevent duplicate job runs:

```ts
await myJob.trigger(
  { id: 'abc123' },
  { idempotencyKey: 'unique-request-id' }
)
```

### With Concurrency Key

Control concurrent execution:

```ts
await myJob.trigger(
  { id: 'abc123' },
  { concurrencyKey: 'user_123' }
)
```

## Job Lifecycle

```
trigger() → pending → running → completed
                  ↘           ↗
                    → failed
```

1. **pending**: Job is queued, waiting for worker
2. **running**: Worker is executing the job
3. **completed**: Job finished successfully
4. **failed**: Job encountered an error

## Error Handling

Errors in steps cause the job to fail:

```ts
await step.run('might-fail', async () => {
  if (someCondition) {
    throw new Error('Something went wrong')
  }
  return result
})
```

The job status becomes `failed` and the error is stored. Failed jobs can be retried using `durably.retry(runId)`.
