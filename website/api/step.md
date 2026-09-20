# Step

The Step object is passed to job handlers and provides methods for creating steps and logging.

## Methods

### `run()`

Creates a resumable step.

```ts
const result = await step.run<T>(
  name: string,
  fn: (signal: AbortSignal, attempt: StepAttemptContext) => T | Promise<T>,
  options?: { metadata?: JsonValue },
): Promise<T>
```

| Parameter | Type                                   | Description                                                                                         |
| --------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `name`    | `string`                               | Unique step name within the job                                                                     |
| `fn`      | `(signal, attempt) => T \| Promise<T>` | Callback to execute. The signal supports cancellation; the attempt identifies this durable attempt. |
| `options` | `{ metadata?: JsonValue }`             | Optional JSON metadata persisted before the callback starts.                                        |

**Returns**: The result of `fn`, either freshly computed or retrieved from cache.

#### Behavior

1. **First execution**: Runs `fn` and persists the result
2. **Subsequent executions**: Returns the cached result without running `fn`

Before trying to invoke a callback, Durably commits a record with its own attempt ID. Cancellation, lease loss, or a crash can prevent the callback from being entered after the record commits. Cached replay does not add an attempt. When invoked, the callback receives `attempt.id`, `attempt.metadata`, `attempt.log`, and `await attempt.setMetadata(jsonValue)` as its second argument. The awaited write replaces the entire JSON value, commits before the promise resolves, and updates `attempt.metadata`. `attempt.log` attaches the step name to each log entry.

```ts
await step.run(
  'call-provider',
  async (signal, attempt) => {
    const response = await callProvider({ signal })
    await attempt.setMetadata({ provider: 'example', usage: response.usage })
    return response.output
  },
  { metadata: { provider: 'example' } },
)
```

Metadata must be a JSON value made of primitives, arrays, and plain objects; class instances and `Date` values are rejected. Omit `metadata` for an initial `null` value; explicitly passing `metadata: undefined` rejects before the callback runs. Invalid updates leave the previous value unchanged. An unresolved attempt remains available after a worker crash or checkpoint write failure even if checkpoint outputs are later cleaned up; `durably.getStepAttempts(runId)` lists it with `completedAt: null`. Its `interruptionReason` is inferred from the current run state and can change until the run is terminal. It does not prove that the callback began or say when external work stopped. Attempts are removed when their run is deleted or purged.

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

### `all()`

Runs independent named steps concurrently and joins after every branch settles. The result retains the branch names and types. A completed branch is replayed from its checkpoint after lease recovery; only unfinished branches invoke their callbacks again.

```ts
const reviews = await step.all({
  codex: async (signal, attempt) => {
    attempt.log.info('Codex review started')
    return reviewWithCodex({ signal })
  },
  claude: async (signal, attempt) => {
    attempt.log.info('Claude review started')
    return reviewWithClaude({ signal })
  },
})
```

Use stable, unique branch names within the job. Numeric step indexes are assigned as branches start and need not follow object key order. Each branch has its own checkpoint and durable attempt record, available through `getStepAttempts(runId)`. Use `attempt.setMetadata()` to save usage or other JSON data for that branch. A result such as `needsChanges` is a normal value; a thrown error is a failure. If one branch throws, the join waits for its siblings to settle. Lease loss or cancellation takes precedence over ordinary errors; with multiple ordinary failures, the error from the lowest-index failed checkpoint is thrown. Sibling attempts remain queryable after terminal failure. A failed join with a successful sibling retains its checkpoints and logs, including the completed output, even with the default `preserveSteps: false`. Other terminal runs follow the normal checkpoint cleanup; `preserveSteps: true` keeps all terminal checkpoints. All branches share the run's cancellation and lease signal. This call keeps the worker slot occupied until the join settles. The earliest attempt start and latest completion measure the group's wall-clock interval; adding branch durations instead measures combined branch work.

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

Inside a parallel callback, use `attempt.log` to attach the correct step name. Once independent callbacks overlap, shared `step.log` is logged without a step name until all active callbacks settle, avoiding false attribution from late logs. Sequentially nested `step.run()` callbacks retain the innermost step name.

### `progress()`

Reports progress for the current run.

```ts
step.progress(current: number, total?: number, message?: string): void
```

| Parameter | Type     | Description                     |
| --------- | -------- | ------------------------------- |
| `current` | `number` | Current progress value          |
| `total`   | `number` | Total progress value (optional) |
| `message` | `string` | Optional progress message       |

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

## Durable external waits

Use a durable wait when CI or a human decision should release the worker slot. Prepare the persisted input address **before** starting external work:

```ts
const wait = await step.prepareWait('ci:review-1', {
  metadata: { commit: input.commit },
})
await step.run('start-ci:review-1', () => startCi({ waitId: wait.id }))
const result = await step.waitFor(wait)
// result: { type: 'signal', payload: JsonValue }
```

An application process sharing the database supplies the result:

```ts
await durably.signal(waitId, { passed: true }, { signalId: 'ci-result-123' })
const receipt = await durably.getWait(waitId)
const waits = await durably.getWaits(runId)
```

`prepareWait(name, { metadata? })` returns a persisted `DurableWait`. Names identify one logical wait within a run: replay returns its original ID and result. Use distinct names for new iterations; retrigger creates new run and wait IDs. Metadata and payload must be JSON. The application validates authorization, payload schema, and commit/version identity; a wait ID is not an authorization credential.

`waitFor(wait)` returns an already accepted signal immediately, including signals received before suspension. Otherwise the run becomes `waiting`, releases its worker slot and lease, and resumes with the same run ID after a signal. Resume calls the job from the beginning and replays completed step results. Keep side effects inside named steps and use external idempotency keys where needed: a crash between an external effect and checkpoint persistence can repeat that effect. JavaScript stacks and local variables are not persisted.

Prepare and await waits only at sequential boundaries in the job body. Do not call them inside step callbacks, parallel branches, or while another step operation is in flight. Await `step.all()` before preparing a wait. Do not catch and suppress suspension or keep running application work after it; the runtime cannot stop arbitrary JavaScript. Suspension creates no step attempt.

The first signal wins. Retrying the same `signalId` and JSON payload returns the original receipt; a different payload or a second signal cannot overwrite it. An accepted receipt means persisted input, not completed downstream work. Unknown/deleted wait IDs are rejected. A signal for another prepared wait does not resume the wait currently blocking the run. New signals to terminal runs are rejected; an already accepted identical retry remains idempotent until the run is deleted.

Waiting releases execution exclusion for `concurrencyKey`; another run with that key may execute. Resume waits for any valid same-key lease. Business resource reservations remain the application's responsibility. `coalesce: 'active'` selects pending, then valid leased, then waiting runs for the same job/key; `skip` and `queue` retain their pending-only reuse behavior. Resolved waits remain `waiting` until claimed. Candidate ordering follows creation time and ID, without a strict fairness guarantee.

Cancel a waiting run before deleting or retriggering it. Cancellation prevents later input from reviving it and cleans checkpoints according to `preserveSteps`, even without a worker. Wait records survive checkpoint cleanup and are removed with run deletion/purge. `waitForRun()` and `triggerAndWait()` still wait for a terminal run; their caller-side timeout does not cancel a durable wait. This release has no durable deadlines or dedicated HTTP signal/wait endpoints.

`run:waiting` reports suspension and `run:leased` reports resume. Existing HTTP run reads/subscriptions and React hooks understand `waiting`. `isActive` remains pending or leased; `isWaiting` identifies waiting; `isTerminal` is false for waiting. Use `!isTerminal` when testing whether a run is unfinished.
