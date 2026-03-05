# Type Definitions

Common types used across both Browser-Complete and Server-Connected modes.

## RunStatus

```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
```

| Status      | Description                                      |
| ----------- | ------------------------------------------------ |
| `pending`   | Job is queued, waiting to be picked up by worker |
| `running`   | Job is currently executing                       |
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

A subset of the core `Run` type returned by HTTP endpoints. Internal fields (`heartbeatAt`, `idempotencyKey`, `concurrencyKey`, `updatedAt`) are excluded.

```ts
interface ClientRun {
  id: string
  jobName: string
  status: RunStatus
  input: unknown
  output: unknown
  error: string | null
  currentStepIndex: number
  stepCount: number
  progress: Progress | null
  labels: Record<string, string>
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}
```

| Property           | Type                     | Description                     |
| ------------------ | ------------------------ | ------------------------------- |
| `id`               | `string`                 | Unique run ID                   |
| `jobName`          | `string`                 | Name of the job                 |
| `status`           | `RunStatus`              | Current status                  |
| `input`            | `unknown`                | Input data                      |
| `output`           | `unknown`                | Job output (when completed)     |
| `error`            | `string \| null`         | Error message (when failed)     |
| `currentStepIndex` | `number`                 | Index of the current step       |
| `stepCount`        | `number`                 | Total number of completed steps |
| `progress`         | `Progress \| null`       | Current progress                |
| `labels`           | `Record<string, string>` | Labels set at trigger time      |
| `startedAt`        | `string \| null`         | ISO timestamp of start          |
| `completedAt`      | `string \| null`         | ISO timestamp of completion     |
| `createdAt`        | `string`                 | ISO timestamp of creation       |

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
