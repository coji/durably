# Type Definitions

Common types used across both Browser-Complete and Server-Connected modes.

## RunStatus

```ts
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
```

| Status | Description |
|--------|-------------|
| `pending` | Job is queued, waiting to be picked up by worker |
| `running` | Job is currently executing |
| `completed` | Job finished successfully |
| `failed` | Job encountered an error |
| `cancelled` | Job was cancelled before completion |

## Progress

```ts
interface Progress {
  current: number
  total?: number
  message?: string
}
```

| Property | Type | Description |
|----------|------|-------------|
| `current` | `number` | Current progress value |
| `total` | `number \| undefined` | Total expected value |
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

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique log entry ID |
| `runId` | `string` | Associated run ID |
| `stepName` | `string \| null` | Step that created the log |
| `level` | `'info' \| 'warn' \| 'error'` | Log severity |
| `message` | `string` | Log message |
| `data` | `unknown` | Optional structured data |
| `timestamp` | `string` | ISO timestamp |

## RunRecord

```ts
interface RunRecord {
  id: string
  jobName: string
  status: RunStatus
  payload: unknown
  output: unknown
  error: string | null
  progress: Progress | null
  createdAt: string
  updatedAt: string
}
```

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique run ID |
| `jobName` | `string` | Name of the job |
| `status` | `RunStatus` | Current status |
| `payload` | `unknown` | Input payload |
| `output` | `unknown` | Job output (when completed) |
| `error` | `string \| null` | Error message (when failed) |
| `progress` | `Progress \| null` | Current progress |
| `createdAt` | `string` | ISO timestamp of creation |
| `updatedAt` | `string` | ISO timestamp of last update |

## StepRecord

```ts
interface StepRecord {
  name: string
  status: 'completed' | 'failed'
  output: unknown
  error: string | null
  startedAt: string
  completedAt: string | null
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Step name |
| `status` | `'completed' \| 'failed'` | Step result |
| `output` | `unknown` | Step return value |
| `error` | `string \| null` | Error message (when failed) |
| `startedAt` | `string` | ISO timestamp of start |
| `completedAt` | `string \| null` | ISO timestamp of completion |
