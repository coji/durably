# Design: Runtime Rearchitecture

## What Durably Does

Durably is a job runtime for Node.js and browsers. You define a job as a sequence of steps. Each step's result is saved to the database. If a worker crashes mid-job, another worker picks up where it left off—no work is lost. The database, not the process, is the source of truth.

### Why Durably

If your app has background work that must finish even when processes restart—sending emails after signup, syncing data on a schedule, running multi-step AI pipelines—you need something that remembers where it left off.

BullMQ and similar job queues solve dispatch and retry well, but they rely on Redis and a long-running worker. Cloudflare Workflows solves durability natively, but locks you into one platform. Durably sits between these: it gives you resumable, checkpointed execution backed by an ordinary database (SQLite or PostgreSQL), and runs the same way on Vercel, Cloudflare, AWS, or your laptop.

### When Not to Use Durably

- **Simple one-shot tasks** that can just retry on failure—a plain queue is simpler.
- **Cloudflare-only projects** where Cloudflare Workflows already covers your needs.
- **Sub-millisecond scheduling**—Durably optimizes for correctness, not for real-time dispatch.

## Goal

Durably should be a simple and reliable job runtime centered on the database.

### Recommended Starting Path

For a solo developer trying Durably with minimal cost and setup:

| Priority            | Stack                        | When to choose                                                                     |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| **First choice**    | `Vercel + Turso`             | Web-first projects, free tier friendly, SQLite-shaped data without a resident file |
| **Second choice**   | `Cloudflare Workers + Turso` | Edge deployment, event-driven execution                                            |
| **Production path** | `Vercel + PostgreSQL`        | Clearest database semantics, natural upgrade from Turso                            |
| **Production path** | `Fly.io + PostgreSQL`        | Resident workers, long-running processes                                           |

> **Cloudflare note:** If your project is Cloudflare-only, evaluate [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) first—it solves a similar problem with less setup. Durably is the better choice when you want the same execution model across Vercel, Cloudflare, AWS, and local development.

For deployment-oriented runtime compositions across resident workers and serverless platforms, see `deployment-models.md`.
For storage-oriented fit and tradeoffs across different databases, see `database-runtime-fit.md`.

### Core Properties

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

> **Key term — lease:** A lease is a temporary execution right. It records which worker currently owns a run and when that right expires. If the worker crashes or the lease expires, another worker can safely take over.

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

### 2. Acquire a Run (Claim)

A worker never reads a pending run and then updates it later.

Instead, it performs one atomic operation to acquire exclusive execution rights:

- select one claimable run
- set `status = leased`
- set `leaseOwner`
- set `leaseExpiresAt`
- set `startedAt` if this is the first claim

If two workers race, only one may receive the lease.

This is a runtime invariant, not a promise that every backend exposes the same first-class queue primitive.
What must be portable is the behavior of `processOne()`: one invocation may safely acquire, execute, renew, and complete at most one run.
The internal claim operation that supports that behavior may differ across adapters.

### 3. Extend Execution Time (Lease Renewal)

While executing, the worker periodically extends its lease.

Renewal succeeds only if:

- the run is still leased
- the lease is still owned by that worker

This prevents a stale worker from extending or completing a run that has already been reclaimed elsewhere.

Phase 1 exploration suggests one additional runtime behavior is worth standardizing:

- lease loss should trigger best-effort cooperative stop inside the current invocation

That means:

- a lease deadline or failed renewal should abort the runtime's in-memory execution context
- later step boundaries should refuse to begin new work once ownership is gone
- long-running async work may observe an `AbortSignal` and stop early

This is not hard preemption of arbitrary user code.
It is a best-effort runtime contract that reduces stale work while still relying on ownership-sensitive writes for correctness.

### 4. Complete or Fail

Completion and failure are ownership-sensitive writes.

The runtime must only transition a run from `leased` to `completed` or `failed` if the current worker still owns the lease.

### 5. Recover Abandoned Runs (Reclaim)

If `leaseExpiresAt` is in the past, the run is no longer owned by anyone.

Another worker can pick it up and continue execution from persisted checkpoints.

This is not a special recovery mode—it is part of the normal acquisition flow.

### Smallest Useful Setup

To make this concrete, here is the minimal shape of a Durably app on Vercel + Turso:

```ts
// 1. Define a job
const sendWelcome = defineJob('send-welcome', async (step, payload) => {
  const user = await step.run('fetch-user', () => db.getUser(payload.userId))
  await step.run('send-email', () => email.send(user.email, 'Welcome!'))
})

// 2. Enqueue from an API route
await durably.trigger('send-welcome', { userId: 'abc' })

// 3. Process runs (called by Vercel Cron or after enqueue)
await durably.processOne()
```

No Redis. No long-running worker. The database holds all state—if `processOne()` is interrupted between steps, the next invocation resumes from the last completed step.

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

### Migration Stance

Phase 1 exploration also clarified the migration direction:

- clean-break schema changes are acceptable
- compatibility columns should not be retained indefinitely just to ease transition

In particular, the old `heartbeat_at` column was removable through a destructive rebuild migration without weakening the lease-based runtime model.
That supports a cleaner Phase 1 schema even if the migration itself is invasive.

## Architectural Split

The current implementation mixes runtime semantics, polling behavior, and Kysely-backed persistence too closely.

The target architecture separates them into four layers:

1. Runtime
2. Store
3. Worker loop
4. Transport and UI integrations

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

It is also the main portability target of the runtime.
Phase 1 exploration showed that a low-level `claimNext()` operation can carry backend-specific locking and visibility assumptions, especially on PostgreSQL.
The design should therefore treat `processOne()` as the first-class contract and `claimNext()` as an adapter-facing building block.

`processUntilIdle({ maxRuns })` is the natural bounded companion for short-lived deployments.
Phase 1 exploration validated it as a good "drain up to N runs, then return" primitive for cron-driven and queue-triggered serverless slices.

### Store

The store owns all persistence: run lifecycle, lease semantics, step checkpoints, progress, and logs.
It is an adapter contract, not the primary public surface of the runtime.

```ts
interface Store<TLabels = Record<string, string>> {
  // Run lifecycle
  enqueue(input: CreateRunInput<TLabels>): Promise<Run<TLabels>>
  enqueueMany(inputs: CreateRunInput<TLabels>[]): Promise<Run<TLabels>[]>
  getRun(runId: string): Promise<Run<TLabels> | null>
  getRuns(filter?: RunFilter<TLabels>): Promise<Run<TLabels>[]>
  updateRun(runId: string, data: UpdateRunData): Promise<void>
  deleteRun(runId: string): Promise<void>

  // Lease management
  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: ClaimOptions,
  ): Promise<Run<TLabels> | null>
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
  cancelRun(runId: string, now: string): Promise<boolean>

  // Steps (checkpoints)
  createStep(input: CreateStepInput): Promise<Step>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
  deleteSteps(runId: string): Promise<void>
  advanceRunStepIndex(runId: string, stepIndex: number): Promise<void>

  // Progress & logs
  updateProgress(runId: string, progress: ProgressData | null): Promise<void>
  createLog(input: CreateLogInput): Promise<Log>
  getLogs(runId: string): Promise<Log[]>
}
```

> **Design Decision — Why a unified Store instead of QueueStore + CheckpointStore:**
>
> The original RFC proposed splitting persistence into a `QueueStore` (run lifecycle and leases) and a `CheckpointStore` (steps, progress, logs). The rationale was that these concerns evolve independently.
>
> Implementation showed that the split was a leaky abstraction:
>
> - `CheckpointStore` wrote to the `durably_runs` table (`advanceRunStepIndex`, `updateProgress`) — the boundary between the two stores was already broken at the data level.
> - Cross-store transactions were impossible. Operations like `deleteRun` need atomic cleanup of steps, logs, and the run row — something that cannot be coordinated across two independent store interfaces.
> - The `Storage` facade that wrapped both stores ended up bypassing them for `updateRun` and `deleteRun`, defeating the purpose of the abstraction.
> - Backend-specific behavior (e.g., SQLite vs PostgreSQL claim strategies) is a concern within a single store implementation, not a reason to split interfaces.
>
> A single `Store` interface is simpler, enables atomic cross-concern operations, and honestly reflects the data model where runs, steps, and logs are tightly coupled.

This contract defines adapter semantics, not SQL shape. Implementations may use SQLite, libSQL, PostgreSQL, or another backend as long as they preserve the runtime guarantees required by `processOne()`.

In particular:

- Durably does not need one portable `claimNext()` implementation across backends
- adapters may use different claim strategies to uphold the same runtime behavior
- if a backend can only defend correctness through a more specialized internal claim path, that is acceptable

### Worker Loop

The worker loop should be thin.

Its job is only to call `runtime.processOne()` repeatedly on a schedule.

It should not contain unique execution semantics. The semantics belong in the runtime so they can be reused by both long-running and one-shot execution modes.

### Transport and UI

HTTP, SSE, and React bindings remain outer layers.

They should depend on runtime interfaces and event streams, not on Kysely or worker internals.

## Concurrency Semantics

Two concurrency concerns must be handled explicitly.

### Only one worker executes a run at a time

At most one worker may hold the active lease for a run at a given time.

This must be guaranteed by the store's acquire and renew operations.

### Preventing parallel runs of the same kind

Some jobs should not run simultaneously even if they are different runs.

This belongs in the acquisition logic. The store should be able to exclude or serialize runs that share a `concurrencyKey`.

This constraint should be enforced at acquisition time, not by in-memory coordination.
Runtime-side preflight reads may help performance, but they are not sufficient as the primary guarantee.

## Preventing Duplicate Runs (Idempotency)

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

One important boundary from exploration should be explicit:

- the runtime can protect final persisted state with ownership-sensitive writes
- best-effort cooperative stop can reduce stale execution after lease loss
- hard interruption of arbitrary synchronous user code is not a realistic goal

## Storage Independence

Durably should not expose SQLite-specific behavior in its core contracts.

The current implementation leaks storage-specific concerns such as JSON query syntax, pagination quirks, and `returning` assumptions. The new architecture should keep those details inside adapter implementations.

The public constructor should accept storage adapters directly.

```ts
interface DurablyOptions<TLabels, TJobs> {
  store: Store<TLabels>
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
3. Claim and reclaim become adapter-level semantics in support of runtime execution.
4. `processOne()` becomes the first-class runtime API.
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

- atomic run acquisition
- resumable execution from checkpoints
- safe lease expiry and automatic recovery
- execution-model independence (daemon and serverless)
- storage-adapter portability (SQLite, PostgreSQL, libSQL, …)

That is the architectural center of gravity. Everything else, including worker loops, HTTP handlers, and React bindings, should sit on top of that model instead of defining it.

One practical boundary from Phase 1 exploration is worth making explicit:

- portability does not mean every backend shares one claim implementation
- portability is centered on `processOne()` semantics, not on exposing one universal `claimNext()` primitive
- PostgreSQL may require a stricter claim path than SQLite-like backends
- browser-local runtimes may support the core lease model while still recommending one active runtime per tab

## Phase 2: Ambient Agent Extension

Ambient agents are a valid target for this runtime, but they should be modeled as an extension layer or separate package built on top of the core runtime.

For a more concrete product image of ambient agents and representative application domains, see `ambient-agent-concepts.md`.

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
