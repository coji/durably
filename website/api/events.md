# Events

Durably provides an event system for monitoring job execution and extensibility.

## Core event categories

Fifteen core event types are exposed as the `DurablyEvent` discriminated union. For filtering and typing, they are grouped into:

- **Domain (lifecycle facts)** — `DomainEvent` / `DomainEventType`: `run:trigger`, `run:coalesced`, `run:waiting`, `run:complete`, `run:fail`, `run:cancel`, `run:delete`
- **Operational (execution and diagnostics)** — `OperationalEvent` / `OperationalEventType`: `run:leased`, `run:lease-renewed`, `run:progress`, `step:start`, `step:complete`, `step:fail`, `step:cancel`, `log:write`, `worker:error`

The helper `isDomainEvent(event)` returns true when `event.type` is a domain event (no `category` field is added to emitted payloads).

```ts
import { isDomainEvent, type DurablyEvent } from '@coji/durably'

// Filter domain events in a handler that receives mixed event types
function handleEvent(event: DurablyEvent) {
  if (isDomainEvent(event)) {
    // narrowed to DomainEvent — state transition facts only
    console.log(event.type, event.runId)
  }
}
```

## Subscribing to Events

```ts
durably.on(eventType: string, listener: (event) => void): void
```

## Event Types

### Run Events

#### `run:trigger`

Fired when a job is triggered (before worker picks it up).

```ts
durably.on('run:trigger', (event) => {
  // event: {
  //   type: 'run:trigger',
  //   runId: string,
  //   jobName: string,
  //   input: unknown,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:coalesced`

Fired when a trigger was coalesced onto an existing pending run with `coalesce: 'skip'`, `'queue'`, or `'active'`, or onto a valid leased or waiting run with `'active'`. Not fired for normal triggers (`'created'`) or idempotent hits (`'idempotent'`). Unused inputs and labels are reported in `skippedInput` and `skippedLabels`, rather than overwriting the selected run.

```ts
durably.on('run:coalesced', (event) => {
  // event: {
  //   type: 'run:coalesced',
  //   runId: string,           // ID of the existing pending, leased, or waiting run
  //   jobName: string,
  //   status: 'pending' | 'leased' | 'waiting',
  //   labels: Record<string, string>,  // existing run's labels
  //   skippedInput: unknown,   // the new input that was NOT used
  //   skippedLabels: Record<string, string>, // the new labels that were NOT used
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:leased`

Fired when a run acquires a lease and begins execution.

```ts
durably.on('run:leased', (event) => {
  // event: {
  //   type: 'run:leased',
  //   runId: string,
  //   jobName: string,
  //   input: unknown,
  //   leaseOwner: string,
  //   leaseExpiresAt: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:lease-renewed`

Fired when a run's lease is renewed during execution.

```ts
durably.on('run:lease-renewed', (event) => {
  // event: {
  //   type: 'run:lease-renewed',
  //   runId: string,
  //   jobName: string,
  //   leaseOwner: string,
  //   leaseExpiresAt: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:complete`

Fired when a run completes successfully.

```ts
durably.on('run:complete', (event) => {
  // event: {
  //   type: 'run:complete',
  //   runId: string,
  //   jobName: string,
  //   output: unknown,
  //   duration: number,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:fail`

Fired when a run fails.

```ts
durably.on('run:fail', (event) => {
  // event: {
  //   type: 'run:fail',
  //   runId: string,
  //   jobName: string,
  //   error: string,
  //   failedStepName: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:progress`

Fired when `step.progress()` is called.

```ts
durably.on('run:progress', (event) => {
  // event: {
  //   type: 'run:progress',
  //   runId: string,
  //   jobName: string,
  //   progress: { current: number, total?: number, message?: string },
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:cancel`

Fired when a run is cancelled via `cancel()` API.

```ts
durably.on('run:cancel', (event) => {
  // event: {
  //   type: 'run:cancel',
  //   runId: string,
  //   jobName: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:delete`

Fired when a run is deleted via `deleteRun()` API.

```ts
durably.on('run:delete', (event) => {
  // event: {
  //   type: 'run:delete',
  //   runId: string,
  //   jobName: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### Step Events

#### `step:start`

Fired when a step begins execution.

```ts
durably.on('step:start', (event) => {
  // event: {
  //   type: 'step:start',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `step:complete`

Fired when a step completes successfully.

```ts
durably.on('step:complete', (event) => {
  // event: {
  //   type: 'step:complete',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   output: unknown,
  //   duration: number,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `step:fail`

Fired when a step fails.

```ts
durably.on('step:fail', (event) => {
  // event: {
  //   type: 'step:fail',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   error: string,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `step:cancel`

Fired when the runtime rejects a step because its run was cancelled. It can occur without a preceding `step:start` if the attempt insert is refused. If cancellation arrives after the attempt insert commits but before the callback begins, neither step event fires; the durable attempt remains unresolved.

```ts
durably.on('step:cancel', (event) => {
  // event: {
  //   type: 'step:cancel',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   labels: Record<string, string>,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### Log Events

#### `log:write`

Fired when `step.log` or callback-scoped `attempt.log` methods are called.

```ts
durably.on('log:write', (event) => {
  // event: {
  //   type: 'log:write',
  //   runId: string,
  //   jobName: string,
  //   labels: Record<string, string>,
  //   stepName: string | null,
  //   level: 'info' | 'warn' | 'error',
  //   message: string,
  //   data: unknown,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### Worker Events

#### `worker:error`

Fired when an internal worker error occurs (e.g., lease renewal failure).

```ts
durably.on('worker:error', (event) => {
  // event: {
  //   type: 'worker:error',
  //   error: string,
  //   context: string,  // e.g., 'lease-renewal', 'cancel-cleanup'
  //   runId?: string,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

## Synchronous Execution

::: warning Listeners run synchronously
Event listeners are called **synchronously** in the worker's hot path. A slow listener will block job execution and lease renewal until it returns. Keep listeners fast and non-blocking.
:::

**Do:**

```ts
// Fast: queue work for later
durably.on('run:complete', (e) => {
  void sendToAnalytics(e) // fire-and-forget async
})

// Fast: simple logging
durably.on('run:fail', (e) => {
  console.error(`[${e.jobName}] Failed: ${e.error}`)
})
```

**Don't:**

```ts
// Slow: synchronous heavy computation blocks the worker
durably.on('run:complete', (e) => {
  const report = generateExpensiveReport(e) // ❌ blocks polling
  fs.writeFileSync('report.json', JSON.stringify(report))
})
```

## Ordering with persisted state

A run or step state change is written to storage first, and its event is emitted directly after that write, before the runtime touches storage again. A listener that reads the run when its event arrives therefore sees the new state. This covers `run:trigger`, `run:coalesced`, `run:leased`, `run:waiting`, `run:complete`, `run:fail`, `run:cancel`, `run:delete`, `step:start`, `step:complete`, and `step:fail`. `batchTrigger()` writes its runs in one storage call and then emits each run's event in order. The guarantee concerns the runtime's own storage access; a synchronous listener may start its own reads before the next event is emitted. With `preserveSteps: false`, a terminal run's checkpoint and log cleanup, where it applies (see [`step.all()`](./step.md) for when a failed run keeps them), starts once listeners have returned. Listeners are not awaited, so an asynchronous listener, or a read on another connection, may find the steps already deleted; set `preserveSteps: true` to read them after a run ends.

The guarantee runs from the write to the event, not the other way. Code that polls storage, such as `getRun()` or `waitForRun()` falling back to polling, can read the new state a moment before the event is delivered. To act on both the state and the event payload, wait for the event.

Limits:

- Events are in-process. Another runtime that shares the database sees the persisted state but receives no events; use `waitForRun()` or the HTTP subscription endpoints there.
- `step:cancel` is emitted when a step observes a cancellation made elsewhere, after reading the run back.
- `log:write` and `run:progress` are emitted when the job calls them. Progress is written in the background; logs are stored only when `withLogPersistence()` is installed, by its `log:write` listener. A listener may briefly read the previous value.
- Maintenance transitions emit no events: expired leases released or failed during idle maintenance, waits expiring at their deadline, and runs removed by `retainRuns` or `purgeRuns()`.

## Error Handling

Exceptions thrown in event listeners are caught and forwarded to the error handler — they do not crash the worker, abort the current run, or interrupt subsequent listeners for the same event. An exception thrown by the `onError` handler itself is ignored for the same reason. If a listener returns a rejected Promise (async listener), the rejection is also forwarded to `onError`. Use `onError` to catch both:

```ts
durably.onError((error, event) => {
  console.error('Listener error:', error, 'during event:', event.type)
})
```

## Type Definitions

All events use a discriminated union pattern:

```ts
interface BaseEvent {
  type: string
  timestamp: string
  sequence: number
}

type DurablyEvent =
  | RunTriggerEvent
  | RunLeasedEvent
  | RunLeaseRenewedEvent
  | RunCompleteEvent
  | RunFailEvent
  | RunCancelEvent
  | RunProgressEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | StepCancelEvent
  | LogWriteEvent
  | WorkerErrorEvent

// Shared data types used by events and callbacks
interface ProgressData {
  current: number
  total?: number
  message?: string
}

interface LogData {
  level: 'info' | 'warn' | 'error'
  message: string
  data?: unknown
  stepName?: string | null
}
```

`RunProgressEvent` contains a `progress: ProgressData` field. `LogWriteEvent` extends `LogData` with additional event fields (`runId`, `jobName`, `labels`, etc.).

Both `ProgressData` and `LogData` are also used as callback parameter types in [`TriggerAndWaitOptions`](/api/create-durably#triggerandwait).

## Example

```ts
const durably = createDurably({ dialect })

// Log all events
durably.on('run:leased', (e) => {
  console.log(`[${e.jobName}] Run leased: ${e.runId}`)
})

durably.on('run:complete', (e) => {
  console.log(`[${e.jobName}] Run completed in ${e.duration}ms`)
})

durably.on('run:fail', (e) => {
  console.error(`[${e.jobName}] Run failed: ${e.error}`)
  // Send alert to monitoring service
  alertService.notify({
    title: `Job ${e.jobName} failed`,
    message: e.error,
    runId: e.runId,
  })
})

durably.on('step:complete', (e) => {
  console.log(`  Step "${e.stepName}" completed in ${e.duration}ms`)
})

// Handle listener errors
durably.onError((error, event) => {
  console.error('Event listener threw:', error)
})
```

### `run:waiting`

Emitted after suspension is persisted. The run has released its lease and worker slot. `run:leased` is emitted again when it resumes with a new lease. HTTP subscriptions restore waiting state from persisted snapshots on reconnect; in-process events alone are not a cross-process delivery guarantee.

```ts
durably.on('run:waiting', (event) => {
  console.log('Waiting:', event.runId)
})
```
