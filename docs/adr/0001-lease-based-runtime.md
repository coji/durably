# ADR-0001: Lease-based runtime model

## Status

Accepted (implemented in #101, March 2026)

## Context

Durably needed a runtime model that works across both long-running workers and serverless platforms (Vercel, Cloudflare Workers). The original design used a `running` status and heartbeat-based liveness detection, which conflated intent with authority and left ambiguous ownership windows.

Key requirements:

- Resumable execution from persisted checkpoints after worker crash
- At most one worker executing a given run at any time
- No dependency on long-running processes
- Portable across SQLite, libSQL, and PostgreSQL

## Decision

### Lease-based execution model

Runs are claimed via atomic lease acquisition. A `leased` status replaces `running`. Each claim increments a monotonic `leaseGeneration` counter (fencing token) that guards all subsequent writes — step persistence, lease renewal, completion, and failure.

`processOne()` is the first-class portable primitive: claim one run, execute it, return. Worker polling loops and `processUntilIdle()` are built on top.

### Unified Store interface

A single `Store` interface owns all persistence: run lifecycle, lease semantics, step checkpoints, progress, and logs. An earlier design split this into `QueueStore` + `CheckpointStore`, but implementation showed the boundary was leaky — `CheckpointStore` wrote to the runs table, and atomic cross-concern operations (like `deleteRun`) required cross-store transactions that couldn't be coordinated.

### Atomic step persistence

`persistStep` replaced the two-step `createStep` + `advanceRunStepIndex` sequence, eliminating a TOCTOU window. Uses `INSERT...SELECT` so ownership check and insert are a single SQL statement.

### Adapter-specific claim paths

`claimNext()` implementations differ per backend:

- **SQLite / libSQL**: Generic claim path works due to single-writer semantics
- **PostgreSQL**: Requires `FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock` for concurrency-key safety. The generic path was proven unsafe under contention (two claimers both received leased results for the same run)

Portability is centered on `processOne()` behavior, not on a universal `claimNext()` implementation.

### Cooperative lease-loss handling

When a lease expires or renewal fails, the runtime aborts in-memory execution: `step.run()` refuses to start new steps, and long-running async work can observe an `AbortSignal`. This is best-effort — hard preemption of synchronous user code is not a goal.

### Browser: single runtime per tab

Browser-local mode (OPFS-backed SQLite) recommends one active Durably runtime per tab. A lightweight `globalThis` registry warns on duplicate creation. Multi-tab reclaim has unresolved visibility issues with SQLocal and is not a supported configuration.

## Consequences

- `running` status removed, replaced by `leased`
- `heartbeat_at` column removed (clean-break migration)
- All lease-holder writes guarded by `leaseGeneration`, not `workerId`
- Completed steps enforced unique per `(run_id, name)` at the database level
- Step output deleted by default on terminal state (`preserveSteps: false`)
- New database adapters must implement adapter-specific claim logic
- Serverless deploys work via `processOne()` / `processUntilIdle()` without polling

## Rejected Alternatives

- **Split Store into QueueStore + CheckpointStore** — Leaky abstraction. CheckpointStore wrote to the runs table, cross-store transactions were impossible, and the Storage facade bypassed both stores.
- **`workerId`-based write guards** — Worker IDs can be reused after restart, making stale owners indistinguishable from current ones. `leaseGeneration` is unforgeable and monotonic.
- **Generic claim path for PostgreSQL** — Proven unsafe. READ COMMITTED snapshot isolation allows concurrent claimers to both succeed without `FOR UPDATE SKIP LOCKED` + advisory locks.
- **Hard preemption on lease loss** — Not realistic for arbitrary synchronous user code. Cooperative stop via AbortSignal is sufficient.
- **Multi-tab browser support** — OPFS exclusivity and SQLocal visibility limits make this unreliable. Single-tab recommendation is the pragmatic choice.
