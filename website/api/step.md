# Step

The Step object is passed to job handlers and provides methods for creating steps and logging.

## Methods

### `run()`

Creates a resumable step.

```ts
const result = await step.run<T>(
  name: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T>
```

| Parameter | Type                                  | Description                                                                                     |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `name`    | `string`                              | Unique step name within the job                                                                 |
| `fn`      | `(signal: AbortSignal) => Promise<T>` | Async function to execute. Receives an `AbortSignal` that is aborted when the run is cancelled. |

**Returns**: The result of `fn`, either freshly computed or retrieved from cache.

#### Behavior

1. **First execution**: Runs `fn` and persists the result
2. **Subsequent executions**: Returns the cached result without running `fn`

```ts
// First run: API is called, result cached
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers() // Called
})

// On resume: Returns cached result
const users = await step.run('fetch-users', async () => {
  return await api.fetchUsers() // NOT called
})
```

#### Cooperative Cancellation

The `signal` parameter enables cooperative cancellation of long-running steps. When a run is cancelled via `durably.cancel(runId)`, the signal is aborted, allowing the step callback to break out of work early.

```ts
await step.run('fetch-all-pages', async (signal) => {
  const results = []
  for (let page = 1; page <= totalPages; page++) {
    if (signal.aborted) break // Stop early on cancellation
    const data = await fetch(`${baseUrl}?page=${page}`, { signal })
    results.push(data)
  }
  return results
})
```

The signal is compatible with `fetch()` and other APIs that accept `AbortSignal`. Existing callbacks that don't use the signal parameter continue to work unchanged.

### `log`

Logger object for writing structured logs.

```ts
step.log.info(message: string, data?: Record<string, unknown>): void
step.log.warn(message: string, data?: Record<string, unknown>): void
step.log.error(message: string, data?: Record<string, unknown>): void
```

| Parameter | Type     | Description              |
| --------- | -------- | ------------------------ |
| `message` | `string` | Log message              |
| `data`    | `object` | Optional structured data |

```ts
step.log.info('Processing started')
step.log.info('User data', { userId: 'abc', count: 10 })
step.log.error('Failed to fetch', { error: err.message })
```

### `progress()`

Reports progress for the current run.

```ts
step.progress(current: number, total: number, message?: string): void
```

| Parameter | Type     | Description               |
| --------- | -------- | ------------------------- |
| `current` | `number` | Current progress value    |
| `total`   | `number` | Total progress value      |
| `message` | `string` | Optional progress message |

```ts
step.progress(0, 100, 'Starting...')
step.progress(50, 100, 'Halfway done')
step.progress(100, 100, 'Complete')
```

## Properties

### `runId`

The unique identifier of the current run.

```ts
const id: string = step.runId
```

## Example

```ts
import { defineJob } from '@coji/durably'

const processOrderJob = defineJob({
  name: 'process-order',
  input: z.object({ orderId: z.string() }),
  run: async (step, input) => {
    step.log.info('Starting order processing', { orderId: input.orderId })

    // Step 1
    const order = await step.run('fetch-order', async () => {
      step.log.info('Fetching order from API')
      return await api.getOrder(input.orderId)
    })

    // Step 2
    await step.run('validate', async () => {
      if (!order.items.length) {
        throw new Error('Order has no items')
      }
      step.log.info('Order validated', { itemCount: order.items.length })
    })

    // Step 3
    await step.run('process-payment', async () => {
      step.log.info('Processing payment')
      await payments.charge(order.total)
    })

    step.log.info('Order processing complete')
    return { success: true }
  },
})

// Register and use
const { processOrder } = durably.register({
  processOrder: processOrderJob,
})
await processOrder.trigger({ orderId: 'order_123' })
```

## Step Naming Best Practices

### Use Descriptive Names

```ts
// Good
await step.run('fetch-user-profile', ...)
await step.run('validate-payment-info', ...)
await step.run('send-confirmation-email', ...)

// Bad
await step.run('step1', ...)
await step.run('s2', ...)
```

### Dynamic Names for Loops

```ts
for (const item of items) {
  await step.run(`process-item-${item.id}`, async () => {
    await processItem(item)
  })
}
```

### Avoid Duplicate Names

```ts
// This will cause issues
await step.run('fetch', async () => { ... })
await step.run('fetch', async () => { ... })  // Wrong!

// Use unique names
await step.run('fetch-users', async () => { ... })
await step.run('fetch-orders', async () => { ... })
```
