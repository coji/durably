# Context

The Context object is passed to job handlers and provides methods for creating steps and logging.

## Methods

### `run()`

Creates a resumable step.

```ts
const result = await context.run<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique step name within the job |
| `fn` | `() => Promise<T>` | Async function to execute |

**Returns**: The result of `fn`, either freshly computed or retrieved from cache.

#### Behavior

1. **First execution**: Runs `fn` and persists the result
2. **Subsequent executions**: Returns the cached result without running `fn`

```ts
// First run: API is called, result cached
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // Called
})

// On resume: Returns cached result
const users = await context.run('fetch-users', async () => {
  return await api.fetchUsers()  // NOT called
})
```

### `log()`

Writes a log entry associated with the current run.

```ts
context.log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | `string` | Log level |
| `message` | `string` | Log message |
| `data` | `object` | Optional structured data |

```ts
context.log('info', 'Processing started')
context.log('debug', 'User data', { userId: 'abc', count: 10 })
context.log('error', 'Failed to fetch', { error: err.message })
```

## Properties

### `runId`

The unique identifier of the current run.

```ts
const id: string = context.runId
```

### `stepIndex`

The current step index (0-based).

```ts
const index: number = context.stepIndex
```

## Example

```ts
durably.defineJob(
  {
    name: 'process-order',
    input: z.object({ orderId: z.string() }),
  },
  async (context, payload) => {
    context.log('info', 'Starting order processing', { orderId: payload.orderId })

    // Step 1
    const order = await context.run('fetch-order', async () => {
      context.log('debug', 'Fetching order from API')
      return await api.getOrder(payload.orderId)
    })

    // Step 2
    await context.run('validate', async () => {
      if (!order.items.length) {
        throw new Error('Order has no items')
      }
      context.log('info', 'Order validated', { itemCount: order.items.length })
    })

    // Step 3
    await context.run('process-payment', async () => {
      context.log('info', 'Processing payment')
      await payments.charge(order.total)
    })

    context.log('info', 'Order processing complete')
    return { success: true }
  },
)
```

## Step Naming Best Practices

### Use Descriptive Names

```ts
// Good
await context.run('fetch-user-profile', ...)
await context.run('validate-payment-info', ...)
await context.run('send-confirmation-email', ...)

// Bad
await context.run('step1', ...)
await context.run('s2', ...)
```

### Dynamic Names for Loops

```ts
for (const item of items) {
  await context.run(`process-item-${item.id}`, async () => {
    await processItem(item)
  })
}
```

### Avoid Duplicate Names

```ts
// This will cause issues
await context.run('fetch', async () => { ... })
await context.run('fetch', async () => { ... })  // Wrong!

// Use unique names
await context.run('fetch-users', async () => { ... })
await context.run('fetch-orders', async () => { ... })
```
