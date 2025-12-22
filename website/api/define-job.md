# defineJob

Defines a new job with typed input and output.

## Signature

```ts
durably.defineJob<I, O>(
  options: JobOptions<I, O>,
  handler: (step: StepContext, payload: I) => Promise<O>
): Job<I, O>
```

## Options

```ts
interface JobOptions<I, O> {
  name: string
  input: z.ZodType<I>
  output?: z.ZodType<O>
}
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier for the job |
| `input` | `ZodSchema` | Yes | Zod schema for validating job input |
| `output` | `ZodSchema` | No | Zod schema for validating job output |

## Handler

The handler function receives:

- `step`: The [Step](/api/step) object for creating steps and logging
- `payload`: The validated input payload

## Returns

Returns a `Job` object with the following methods:

### `trigger()`

```ts
await job.trigger(
  input: I,
  options?: TriggerOptions
): Promise<void>
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
import { z } from 'zod'

const syncUsers = durably.defineJob(
  {
    name: 'sync-users',
    input: z.object({
      orgId: z.string(),
      force: z.boolean().optional(),
    }),
    output: z.object({
      syncedCount: z.number(),
      errors: z.array(z.string()),
    }),
  },
  async (step, payload) => {
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
)

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
const job = durably.defineJob(
  {
    name: 'example',
    input: z.object({ id: z.string() }),
    output: z.object({ result: z.number() }),
  },
  async (step, payload) => {
    // payload is typed as { id: string }
    return { result: 42 }  // Must match output schema
  },
)

// trigger() is typed
await job.trigger({ id: 'abc' })  // OK
await job.trigger({ wrong: 1 })   // Type error
```
