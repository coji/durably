# defineJob

Defines a new job definition with typed input, output, and run function.

## Signature

```ts
import { defineJob } from '@coji/durably'

const jobDef = defineJob<TName, TInput, TOutput>({
  name: TName,
  input: z.ZodType<TInput>,
  output?: z.ZodType<TOutput>,
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
})
```

## Options

```ts
interface DefineJobConfig<TName, TInput, TOutput> {
  name: TName
  input: z.ZodType<TInput>
  output?: z.ZodType<TOutput>
  run: (step: StepContext, payload: TInput) => Promise<TOutput>
}
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier for the job |
| `input` | `ZodSchema` | Yes | Zod schema for validating job input |
| `output` | `ZodSchema` | No | Zod schema for validating job output |
| `run` | `Function` | Yes | The job's run function |

## Run Function

The run function receives:

- `step`: The [Step](/api/step) object for creating steps and logging
- `payload`: The validated input payload

## Returns

Returns a `JobDefinition` object that can be registered with `durably.register()`.

## Registering Jobs

Use `durably.register()` to register job definitions and get job handles:

```ts
const { job } = durably.register({
  job: jobDef,
})

// Multiple jobs at once
const { syncUsers, importCsv } = durably.register({
  syncUsers: syncUsersJob,
  importCsv: importCsvJob,
})
```

The job handle provides the following methods:

### `trigger()`

```ts
await job.trigger(
  input: TInput,
  options?: TriggerOptions
): Promise<Run<TOutput>>
```

Triggers a new job run.

#### Trigger Options

```ts
interface TriggerOptions {
  idempotencyKey?: string
  concurrencyKey?: string
}
```

| Option | Description |
|--------|-------------|
| `idempotencyKey` | Prevents duplicate runs with the same key |
| `concurrencyKey` | Groups jobs for concurrency control |

## Example

```ts
import { createDurably, defineJob } from '@coji/durably'
import { z } from 'zod'

// Define the job
const syncUsersJob = defineJob({
  name: 'sync-users',
  input: z.object({
    orgId: z.string(),
    force: z.boolean().optional(),
  }),
  output: z.object({
    syncedCount: z.number(),
    errors: z.array(z.string()),
  }),
  run: async (step, payload) => {
    const users = await step.run('fetch-users', async () => {
      return await api.fetchUsers(payload.orgId)
    })

    const errors: string[] = []
    for (const user of users) {
      await step.run(`sync-${user.id}`, async () => {
        try {
          await db.upsertUser(user)
        } catch (e) {
          errors.push(`Failed to sync ${user.id}`)
        }
      })
    }

    return {
      syncedCount: users.length - errors.length,
      errors,
    }
  },
})

// Register with durably instance
const { syncUsers } = durably.register({
  syncUsers: syncUsersJob,
})

// Trigger the job
await syncUsers.trigger({ orgId: 'org_123' })

// With idempotency
await syncUsers.trigger(
  { orgId: 'org_123' },
  { idempotencyKey: 'sync-org_123-2024-01-01' }
)
```

## Type Inference

Input and output types are inferred from the Zod schemas:

```ts
const exampleJob = defineJob({
  name: 'example',
  input: z.object({ id: z.string() }),
  output: z.object({ result: z.number() }),
  run: async (step, payload) => {
    // payload is typed as { id: string }
    return { result: 42 }  // Must match output schema
  },
})

const { job } = durably.register({
  job: exampleJob,
})

// trigger() is typed
await job.trigger({ id: 'abc' })  // OK
await job.trigger({ wrong: 1 })   // Type error
```

## Idempotent Registration

Registering the same `JobDefinition` instance multiple times returns the same job handle:

```ts
const jobDef = defineJob({ name: 'my-job', ... })

const { job: handle1 } = durably.register({ job: jobDef })
const { job: handle2 } = durably.register({ job: jobDef })

console.log(handle1 === handle2) // true
```

This enables safe usage in React components where effects may run multiple times.
