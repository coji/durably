# Type Definitions

Common types used across both SPA and Fullstack modes.

The React package’s SSE and client event shapes are **transport-layer** unions for the wire protocol. They are not the same symbols as `@coji/durably`’s `DomainEvent` / `OperationalEvent` helpers (`isDomainEvent`, etc.) exported from the core package — use the core helpers when classifying events inside Node or shared libraries; use hook payloads and documented client types when handling SSE in the browser.

## RunStatus

```ts
type RunStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'
```

| Status      | Description                                      |
| ----------- | ------------------------------------------------ |
| `pending`   | Job is queued, waiting to be picked up by worker |
| `leased`    | Job is currently executing                       |
| `completed` | Job finished successfully                        |
| `failed`    | Job encountered an error                         |
| `cancelled` | Job was cancelled before completion              |

## Progress

```ts
interface Progress {
  current: number
  total?: number
  message?: string
}
```

| Property  | Type                  | Description                     |
| --------- | --------------------- | ------------------------------- |
| `current` | `number`              | Current progress value          |
| `total`   | `number \| undefined` | Total expected value            |
| `message` | `string \| undefined` | Human-readable progress message |

## LogEntry

```ts
interface LogEntry {
  id: string
  runId: string
  stepName: string | null
  level: 'info' | 'warn' | 'error'
  message: string
  data: unknown
  timestamp: string
}
```

| Property    | Type                          | Description               |
| ----------- | ----------------------------- | ------------------------- |
| `id`        | `string`                      | Unique log entry ID       |
| `runId`     | `string`                      | Associated run ID         |
| `stepName`  | `string \| null`              | Step that created the log |
| `level`     | `'info' \| 'warn' \| 'error'` | Log severity              |
| `message`   | `string`                      | Log message               |
| `data`      | `unknown`                     | Optional structured data  |
| `timestamp` | `string`                      | ISO timestamp             |

## ClientRun

A subset of the core `Run` type returned by HTTP endpoints. Internal fields (`leaseOwner`, `leaseExpiresAt`, `idempotencyKey`, `concurrencyKey`, `updatedAt`) are excluded.

```ts
interface ClientRun {
  id: string
  jobName: string
  status: RunStatus
  input: unknown
  output: unknown
  error: string | null
  currentStepIndex: number
  completedStepCount: number
  progress: Progress | null
  labels: Record<string, string>
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}
```

| Property             | Type                     | Description                     |
| -------------------- | ------------------------ | ------------------------------- |
| `id`                 | `string`                 | Unique run ID                   |
| `jobName`            | `string`                 | Name of the job                 |
| `status`             | `RunStatus`              | Current status                  |
| `input`              | `unknown`                | Input data                      |
| `output`             | `unknown`                | Job output (when completed)     |
| `error`              | `string \| null`         | Error message (when failed)     |
| `currentStepIndex`   | `number`                 | Index of the current step       |
| `completedStepCount` | `number`                 | Total number of completed steps |
| `progress`           | `Progress \| null`       | Current progress                |
| `labels`             | `Record<string, string>` | Labels set at trigger time      |
| `startedAt`          | `string \| null`         | ISO timestamp of start          |
| `completedAt`        | `string \| null`         | ISO timestamp of completion     |
| `createdAt`          | `string`                 | ISO timestamp of creation       |

## TypedClientRun

A typed version of `ClientRun` with generic input/output types. Used by fullstack hooks (HTTP/SSE connection).

```ts
type TypedClientRun<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined = Record<string, unknown>,
> = Omit<ClientRun, 'input' | 'output'> & {
  input: TInput
  output: TOutput | null
}
```

Use with `useRuns` to get typed runs in a multi-job dashboard:

```tsx
type ImportRun = TypedClientRun<{ file: string }, { count: number }>
type SyncRun = TypedClientRun<{ userId: string }, { synced: boolean }>
type DashboardRun = ImportRun | SyncRun

const { runs } = durably.useRuns<DashboardRun>({ pageSize: 10 })
```

## TypedRun

A typed version of the core `Run` type with generic input/output types. Used by SPA hooks (direct Durably access). Same shape as `TypedClientRun` but based on the full `Run` type (includes internal fields like `leaseOwner`).

```ts
type TypedRun<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> | undefined = Record<string, unknown>,
> = Omit<Run, 'input' | 'output'> & {
  input: TInput
  output: TOutput | null
}
```

## DurablyEvent

Union type for all SSE events streamed from the server. Useful for custom event handling.

```ts
type DurablyEvent =
  | { type: 'run:leased'; runId: string; jobName: string; input: unknown }
  | {
      type: 'run:complete'
      runId: string
      jobName: string
      output: unknown
      duration: number
    }
  | { type: 'run:fail'; runId: string; jobName: string; error: string }
  | { type: 'run:cancel'; runId: string; jobName: string }
  | { type: 'run:delete'; runId: string; jobName: string }
  | { type: 'run:trigger'; runId: string; jobName: string; input: unknown }
  | {
      type: 'run:coalesced'
      runId: string
      jobName: string
      labels: Record<string, string>
      skippedInput: unknown
      skippedLabels: Record<string, string>
    }
  | { type: 'run:progress'; runId: string; jobName: string; progress: Progress }
  | {
      type: 'step:start'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
    }
  | {
      type: 'step:complete'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
      output: unknown
    }
  | {
      type: 'step:cancel'
      runId: string
      jobName: string
      stepName: string
      stepIndex: number
      labels: Record<string, string>
    }
  | {
      type: 'log:write'
      runId: string
      jobName: string
      stepName: string | null
      labels: Record<string, string>
      level: 'info' | 'warn' | 'error'
      message: string
      data: unknown
    }
```

All events include `runId` and `jobName`. Unlike core Durably events, SSE events omit `timestamp` and `sequence` — only the fields needed by the UI are sent.

## StepRecord

```ts
interface StepRecord {
  name: string
  status: 'completed' | 'failed' | 'cancelled'
  output: unknown
  error: string | null
  startedAt: string
  completedAt: string | null
}
```

| Property      | Type                                     | Description                 |
| ------------- | ---------------------------------------- | --------------------------- |
| `name`        | `string`                                 | Step name                   |
| `status`      | `'completed' \| 'failed' \| 'cancelled'` | Step result                 |
| `output`      | `unknown`                                | Step return value           |
| `error`       | `string \| null`                         | Error message (when failed) |
| `startedAt`   | `string`                                 | ISO timestamp of start      |
| `completedAt` | `string \| null`                         | ISO timestamp of completion |
