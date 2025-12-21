# Events

Durably provides an event system for monitoring job execution and extensibility.

## Subscribing to Events

```ts
durably.on(eventType: string, listener: (event) => void): void
```

## Event Types

### Run Events

#### `run:start`

Fired when a run begins execution.

```ts
durably.on('run:start', (event) => {
  // event: {
  //   type: 'run:start',
  //   runId: string,
  //   jobName: string,
  //   payload: unknown,
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
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### Log Events

#### `log:write`

Fired when `context.log()` is called.

```ts
durably.on('log:write', (event) => {
  // event: {
  //   type: 'log:write',
  //   runId: string,
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

Fired when an internal worker error occurs (e.g., heartbeat failure).

```ts
durably.on('worker:error', (event) => {
  // event: {
  //   type: 'worker:error',
  //   error: string,
  //   context: string,  // e.g., 'heartbeat'
  //   runId?: string,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

## Error Handling

Exceptions in event listeners don't affect run execution. To catch listener errors:

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
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
  | WorkerErrorEvent
```

## Example

```ts
const durably = createDurably({ dialect })

// Log all events
durably.on('run:start', (e) => {
  console.log(`[${e.jobName}] Run started: ${e.runId}`)
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
