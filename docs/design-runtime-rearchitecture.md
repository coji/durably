# Design: Runtime Rearchitecture

## Goal

Durably should be a simple and reliable job runtime centered on the database.

The core runtime must satisfy these properties:

- Job execution is resumable from persisted checkpoints.
- Multiple workers must not execute the same claimed run concurrently.
- If a worker stops mid-execution, another worker can safely continue later.
- The execution model must not be tied to a long-running process.
- The storage model must not be tied to SQLite, even if SQLite remains the default implementation.

This document describes the target architecture without preserving backward compatibility.

It is intentionally split into two phases:

- Phase 1: core job runtime redesign
- Phase 2: ambient agent extension built on top of the runtime

The main point is scope control. The core value of Durably is durable, resumable job execution. Ambient agents are a valid extension, but they are not the minimal core.

## Phase 1: Core Runtime Redesign

## Design Principles

1. The database is the source of truth.
2. Job execution is resumable by default.
3. Claiming execution rights must be atomic.
4. Execution rights are modeled as time-bound leases.
5. Failure recovery is part of the normal control flow.
6. The runtime must support both daemon and serverless execution.
7. Storage-specific behavior must be isolated behind explicit contracts.
8. Correctness takes priority over convenience and implicit magic.

## Core Model

The central object is a run.

A run is a single execution of a job with input, status, checkpoints, and lease state.

```ts
type RunStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'

interface RunRecord<TLabels = Record<string, string>> {
  id: string
  jobName: string
  input: unknown
  status: RunStatus

  idempotencyKey: string | null
  concurrencyKey: string | null
  labels: TLabels

  leaseOwner: string | null
  leaseExpiresAt: string | null

  currentStepIndex: number
  progress: { current: number; total?: number; message?: string } | null

  output: unknown | null
  error: string | null

  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}
```

### Why `leased` instead of `running`

`running` describes intent, not authority.

The runtime needs an explicit representation of who currently owns execution and until when. A lease-based model makes worker ownership, expiration, reclamation, and race handling first-class instead of implicit.

## Execution Semantics

### 1. Enqueue

Triggering a job creates a `pending` run.

The enqueue operation may apply idempotency rules, but those rules must be enforced by the store contract, not by best-effort preflight reads in application code.

### 2. Claim

A worker never reads a pending run and then updates it later.

Instead, it performs one atomic claim operation:

- select one claimable run
- set `status = leased`
- set `leaseOwner`
- set `leaseExpiresAt`
- set `startedAt` if this is the first claim

If two workers race, only one may receive the lease.

### 3. Renew

While executing, the worker periodically renews the lease.

Renewal succeeds only if:

- the run is still leased
- the lease is still owned by that worker

This prevents a stale worker from extending or completing a run that has already been reclaimed elsewhere.

### 4. Complete or Fail

Completion and failure are ownership-sensitive writes.

The runtime must only transition a run from `leased` to `completed` or `failed` if the current worker still owns the lease.

### 5. Reclaim

If `leaseExpiresAt` is in the past, the run is no longer owned.

Another worker may reclaim it and continue execution from persisted checkpoints.

Reclaim is not a special recovery mode. It is part of normal claim semantics.

## Checkpoint Model

A job is split into steps. Each successful step is persisted as a checkpoint.

On re-execution:

- if the step already completed, its persisted output is returned
- otherwise the step function executes normally

This model makes process restart and worker failover safe as long as side effects are isolated at sensible step boundaries.

```ts
interface StepRecord {
  id: string
  runId: string
  name: string
  index: number
  status: 'completed' | 'failed' | 'cancelled'
  output: unknown | null
  error: string | null
  startedAt: string
  completedAt: string | null
}
```

### Checkpoint Retention

Checkpoint deletion must not be part of the default execution path.

The default behavior should preserve step history because resumability and auditability depend on it. Retention and cleanup should be handled explicitly, for example by a maintenance job or time-based policy.

## Architectural Split

The current implementation mixes runtime semantics, polling behavior, and Kysely-backed persistence too closely.

The target architecture separates them into five layers:

1. Runtime
2. Queue store
3. Checkpoint store
4. Worker loop
5. Transport and UI integrations

### Runtime

The runtime owns job registration, execution semantics, lease handling, and resumability.

It should expose both daemon-friendly and serverless-friendly entry points.

```ts
interface DurablyRuntime<TJobs, TLabels = Record<string, string>> {
  readonly jobs: TJobs

  init(): Promise<void>
  migrate(): Promise<void>

  processOne(options?: { workerId?: string }): Promise<boolean>
  processUntilIdle(options?: {
    workerId?: string
    maxRuns?: number
  }): Promise<number>

  start(options?: { workerId?: string }): void
  stop(): Promise<void>

  getRun(runId: string): Promise<RunRecord<TLabels> | null>
  getRuns(filter?: RunFilter<TLabels>): Promise<RunRecord<TLabels>[]>

  cancel(runId: string): Promise<void>
  retrigger(runId: string): Promise<RunRecord<TLabels>>
}
```

`processOne()` is the key addition. It allows one-shot execution in cron jobs, HTTP handlers, queue-triggered functions, and serverless platforms without requiring a resident polling loop.

### Queue Store

The queue store owns run lifecycle and lease semantics.

```ts
interface QueueStore<TLabels = Record<string, string>> {
  enqueue(input: EnqueueRunInput<TLabels>): Promise<RunRecord<TLabels>>
  enqueueMany(inputs: EnqueueRunInput<TLabels>[]): Promise<RunRecord<TLabels>[]>

  getRun(runId: string): Promise<RunRecord<TLabels> | null>
  listRuns(filter?: RunFilter<TLabels>): Promise<RunRecord<TLabels>[]>

  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: { excludeConcurrencyKeys?: string[] },
  ): Promise<RunRecord<TLabels> | null>

  renewLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): Promise<boolean>

  releaseExpiredLeases(now: string): Promise<number>

  completeRun(
    runId: string,
    workerId: string,
    output: unknown,
    completedAt: string,
  ): Promise<boolean>

  failRun(
    runId: string,
    workerId: string,
    error: string,
    completedAt: string,
  ): Promise<boolean>

  cancelRun(runId: string, now: string): Promise<void>
  deleteRun(runId: string): Promise<void>
}
```

This contract defines semantics, not SQL shape. Implementations may use SQLite, libSQL, PostgreSQL, or another backend as long as they preserve the same guarantees.

### Checkpoint Store

The checkpoint store owns step persistence, progress, and logs.

```ts
interface CheckpointStore {
  saveStep(input: SaveStepInput): Promise<void>
  getCompletedStep(runId: string, stepName: string): Promise<StepRecord | null>
  listSteps(runId: string): Promise<StepRecord[]>

  updateProgress(runId: string, progress: Progress): Promise<void>

  appendLog(input: CreateLogInput): Promise<void>
  getLogs(runId: string): Promise<LogRecord[]>

  clearCheckpoints?(runId: string): Promise<void>
}
```

This split is intentional. Lease ownership and checkpoint persistence evolve for different reasons and should not be coupled by one oversized storage interface.

### Worker Loop

The worker loop should be thin.

Its job is only to call `runtime.processOne()` repeatedly on a schedule.

It should not contain unique execution semantics. The semantics belong in the runtime so they can be reused by both long-running and one-shot execution modes.

### Transport and UI

HTTP, SSE, and React bindings remain outer layers.

They should depend on runtime interfaces and event streams, not on Kysely or worker internals.

## Concurrency Semantics

Two concurrency concerns must be handled explicitly.

### Claim exclusivity

At most one worker may hold the active lease for a run at a given time.

This must be guaranteed by the queue store's claim and renew operations.

### Concurrency keys

Some jobs should not run simultaneously even if they are different runs.

This belongs in claim semantics. The queue store should be able to exclude or serialize runs that share a `concurrencyKey`.

This constraint should be enforced at claim time, not by in-memory coordination.

## Idempotency Semantics

Idempotency is a storage guarantee, not a userland optimization.

The runtime should define this rule:

- if `idempotencyKey` is absent, enqueue always creates a new run
- if `idempotencyKey` is present, enqueue returns the existing run for that `(jobName, idempotencyKey)` pair or creates exactly one new run

The implementation should use database constraints and conflict-aware writes, not a read-then-insert race.

## Failure Model

The runtime assumes all of the following can happen:

- worker crash
- process restart
- network interruption
- partial step execution
- stale lease holder waking up late

The design response is:

- persist step checkpoints
- bind lease mutation to `workerId`
- reject stale completions and renewals
- reclaim expired runs automatically through claim semantics

Failure handling is not an add-on. It is the core execution model.

## Storage Independence

Durably should not expose SQLite-specific behavior in its core contracts.

The current implementation leaks storage-specific concerns such as JSON query syntax, pagination quirks, and `returning` assumptions. The new architecture should keep those details inside adapter implementations.

The public constructor should accept storage adapters directly.

```ts
interface DurablyOptions<TLabels, TJobs> {
  store: {
    queue: QueueStore<TLabels>
    checkpoint: CheckpointStore
  }
  migrations?: MigrationDriver
  jobs?: TJobs
  labels?: z.ZodType<TLabels>

  leaseMs?: number
  heartbeatIntervalMs?: number
  pollingIntervalMs?: number
}
```

Then convenience constructors can exist separately:

- `createDurablyWithKysely(...)`
- `createDurablyWithLibsql(...)`
- `createDurablyWithPostgres(...)`

The important point is that these are adapters, not the runtime itself.

## Recommended Event Model

Events should reflect runtime semantics, not UI concerns.

Recommended run-level events:

- `run:enqueued`
- `run:leased`
- `run:lease-renewed`
- `run:completed`
- `run:failed`
- `run:cancelled`
- `run:deleted`
- `run:progress`

Recommended step-level events:

- `step:started`
- `step:completed`
- `step:failed`
- `step:cancelled`

Recommended internal error event:

- `worker:error`

`run:leased` is more precise than `run:start` because it reflects acquisition of execution authority.

## What Changes from the Current Design

This design deliberately changes several assumptions.

1. `running` becomes `leased`.
2. Heartbeat becomes explicit lease renewal.
3. Claim and reclaim become storage-level semantics.
4. `processOne()` becomes a first-class runtime API.
5. Long-running polling becomes an optional loop, not the core model.
6. Storage is injected as adapters instead of being created from a dialect inside the runtime.
7. Step cleanup is no longer a default execution behavior.
8. Ownership-sensitive writes require `workerId`.

## Non-Goals

This design does not attempt to provide:

- distributed tracing
- workflow graph scheduling
- exactly-once side effects outside the database
- generalized message-broker semantics

Durably should stay focused on durable, resumable, lease-based job execution.

## Summary

The target system is a lease-based runtime with persisted checkpoints.

Its core guarantees are:

- atomic claim
- resumable execution
- safe lease expiry and reclamation
- execution-model independence
- storage-adapter portability

That is the architectural center of gravity. Everything else, including worker loops, HTTP handlers, and React bindings, should sit on top of that model instead of defining it.

## Phase 2: Ambient Agent Extension

Ambient agents are a valid target for this runtime, but they should be modeled as an extension layer or separate package built on top of the core runtime.

A plausible package boundary is:

- core runtime in `@coji/durably`
- ambient agent layer in a higher-level package such as `@coji/durably-agent`

The reason is straightforward:

- the core value of Durably is durable, resumable job execution
- agent sessions, streamed UI output, and snapshot recovery are higher-level concerns
- those concerns benefit from the same lease and checkpoint model, but they should not complicate the minimal core

### Extension Model

The extension would add three concepts on top of the core runtime:

1. `Session`
2. `AgentEvent`
3. `Snapshot`

```ts
interface SessionRecord {
  id: string
  agentName: string
  status: 'active' | 'idle' | 'completed' | 'failed' | 'cancelled'
  input: unknown | null
  snapshot: unknown | null
  createdAt: string
  updatedAt: string
}

interface AgentEventRecord {
  id: string
  sessionId: string
  runId: string | null
  sequence: number
  type: string
  payload: unknown
  createdAt: string
}
```

In that model:

- `Session` is the continuity boundary for UI and agent state
- `Run` is one leased execution attempt, optionally associated with a session
- `Step` remains the checkpointed execution unit inside a run
- `AgentEvent` is the append-only stream used to reconstruct UI-visible output

### Session and Run Relationship

In the core runtime, runs do not require sessions.

Session association should be optional and introduced only by the agent layer. That keeps ordinary job execution simple and preserves a clear separation:

- plain job runtime: runs and steps
- ambient agent runtime: sessions, runs, steps, and durable event streams

### Durable Streaming Requirement

If the runtime is used for agent workloads, user-visible streamed output must be persisted as ordered events before or as it is delivered live to clients.

This enables:

1. live streaming during execution
2. UI recovery after reload
3. replay after reconnect
4. continuity after worker failover

Recommended event categories include:

- `token.delta`
- `message.started`
- `message.delta`
- `message.completed`
- `tool.call.started`
- `tool.call.completed`
- `tool.call.failed`
- `state.updated`

### Cursor-Based Recovery

Clients should be able to:

1. load a session
2. load the latest snapshot if present
3. replay persisted events after a known cursor
4. subscribe to live events from that cursor

This makes reload and reconnect normal recovery paths rather than special behavior.

### Snapshot Ownership

Snapshot creation should not be implicit in the core runtime.

The agent layer should define snapshot policy explicitly. That policy may be:

- user-managed snapshots
- framework-managed periodic snapshots
- threshold-based snapshots after N events or bytes

The important rule is that snapshot strategy belongs to the agent extension layer, because it is driven by UI and agent-state reconstruction needs rather than by core run execution semantics.

### Extension Stores

If the agent layer is implemented, it should add its own stores explicitly rather than stretching the core `store` contract:

```ts
interface SessionStore {
  createSession(input: CreateSessionInput): Promise<SessionRecord>
  getSession(sessionId: string): Promise<SessionRecord | null>
  updateSession(sessionId: string, patch: UpdateSessionInput): Promise<void>
}

interface AgentEventStore {
  append(event: AppendAgentEventInput): Promise<AgentEventRecord>
  list(
    sessionId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<AgentEventRecord[]>
  subscribe(
    sessionId: string,
    options?: { afterSequence?: number },
  ): ReadableStream<AgentEventRecord>
}
```

This is another reason to keep the feature out of the Phase 1 runtime redesign. If these stores are required, they should be required by the agent package, not by the core job runtime.
