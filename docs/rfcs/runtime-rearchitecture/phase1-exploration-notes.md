# Phase 1 Exploration Notes

This file captures concrete findings from the exploratory implementation on branch `phase1-runtime-exploration`.

## Findings

### 1. `heartbeat_at` cannot be cleanly removed as a first move

The current SQLite migration story still creates `heartbeat_at` as a required column in schema version 1.

That means a Phase 1 implementation has three realistic options:

- keep a compatibility column for one transition period
- rebuild the schema from scratch and explicitly drop migration compatibility
- introduce a more invasive SQLite table-rebuild migration

For exploration, the implementation keeps `heartbeat_at` as a compatibility column and mirrors lease activity into it. This keeps the runtime executable without committing to the final migration shape.

### 2. `run:start` rename has wider blast radius than the RFC text suggests

Renaming `run:start` to `run:leased` affects:

- server-side SSE payloads
- React client assumptions
- tests and fixtures
- examples and docs

For exploration, both `run:leased` and a compatibility `run:start` event are emitted. Final Phase 1 should choose whether the break is immediate or staged, but leaving both permanently would blur the semantic change.

### 3. `releaseExpiredLeases()` is probably optional

The runtime can safely reclaim work in two different ways:

- `claimNext()` directly treats expired leases as claimable
- a separate `releaseExpiredLeases()` pass resets expired runs to `pending`

The exploratory implementation currently does both, mainly to make behavior explicit.

That likely means the final design should pick one:

- keep `claimNext()` as the only reclaim path for a tighter contract
- keep `releaseExpiredLeases()` only if external maintenance tooling needs it

### 4. `currentStepIndex` and `progress` do not sit cleanly in `QueueStore`

Once queue semantics are lease-focused, step progress and checkpoint advancement feel misplaced there.

In the exploratory implementation, `CheckpointStore` owns:

- step persistence
- progress persistence
- advancing `currentStepIndex`

This suggests the RFC should describe `currentStepIndex` as checkpoint-owned runtime state even if it remains physically stored on the run row.

### 5. `concurrencyKey` safety has to live in `claimNext()`, not only in runtime pre-scan

The exploratory runtime initially derived `excludeConcurrencyKeys` by:

- listing currently leased runs
- passing those keys into `claimNext()`

That is not sufficient as the primary guarantee.

If two workers observe the same empty leased set and then both call `claimNext()`, they can still race on pending runs that share a `concurrencyKey`.

Exploration result:

- `concurrencyKey` serialization must be enforced inside the claim path itself
- runtime-side pre-scan can still exist as a fast path, but it cannot be the only protection

### 6. Stale-owner safety currently protects final state, not in-flight execution

End-to-end runtime tests confirmed that a stale worker cannot overwrite the final state after another worker has reclaimed the run.

Validated so far:

- a stale `completeRun()` does not overwrite the reclaimer's successful completion
- a stale `failRun()` does not overwrite the reclaimer's successful completion

The initial runtime behavior was weaker:

- if a worker lost its lease while job code was running, the job function kept running until it returned or threw
- stale ownership was only rejected at `renewLease()`, `completeRun()`, or `failRun()`

Exploratory cooperative-stop implementation improved that baseline:

- execution now aborts locally when the current lease deadline is reached
- a lost lease also aborts execution when renewal fails
- `step.run()` checks ownership again at the next step boundary
- long-running async steps can observe lease loss through `AbortSignal`
- later steps are not started once lease ownership has been lost

Current interpretation:

- final run state consistency is protected
- cooperative user code can now stop relatively quickly after lease loss
- hard preemption still does not exist for non-cooperative synchronous work

That suggests a good Phase 1 stance:

- best-effort cooperative stop is worth supporting
- hard interruption of arbitrary user code is not a realistic goal

### 7. `processUntilIdle()` is a viable serverless batch primitive

Exploratory node-side tests validated the basic serverless slice model:

- `processUntilIdle({ maxRuns })` respects the requested cap and leaves the remaining backlog for a later invocation
- it returns `0` quickly when no work is claimable
- separate invocations can drain the same backlog concurrently without double-processing completed runs

Current interpretation:

- `processOne()` remains the clearest portable primitive
- `processUntilIdle({ maxRuns })` is still a good fit for cron-driven or queue-triggered batch slices
- the API is already strong enough for a "best-effort drain a bounded amount of work" contract

Open edge not yet explored:

- explicit wall-clock budget controls such as `maxDurationMs`
- behavior when one invocation is terminated mid-run by the platform rather than finishing its current run

## Current exploration scope

Implemented and smoke-tested:

- `leased` run status
- `lease_owner` / `lease_expires_at`
- `QueueStore` / `CheckpointStore` split
- `processOne()` / `processUntilIdle()`
- reclaiming expired leases

Not yet updated consistently:

- existing legacy tests
- React package surface
- public docs and examples
- removal of compatibility shims

## Database validation notes

### PostgreSQL

We validated PostgreSQL against the Phase 1 lease contract with a docker-compose database and dedicated test helpers.

Most important finding:

- the generic `claimNext()` shape used for SQLite-like adapters is not safe on PostgreSQL

This was reproduced directly by forcing PostgreSQL through the generic path:

- two concurrent claimers both received a leased result for the same run
- both saw the same `run.id`
- each saw itself as `leaseOwner`

Implication:

- PostgreSQL needs a dedicated adapter path for claim
- `FOR UPDATE SKIP LOCKED` style claim logic is not optional if PostgreSQL is a first-class backend

After switching PostgreSQL to a dedicated path, the following checks passed:

- idempotent enqueue
- single-winner claim
- stale renew rejection
- stale completion rejection after reclaim
- expired lease reclaim
- `startedAt` preservation on reclaim
- multi-runtime stress checks against the same database

Additional `concurrencyKey` exploration:

- the runtime-level guarantee now holds in end-to-end tests: two separate runtimes did not execute same-key runs concurrently
- sequential guard behavior also holds: once one same-key run is leased, a later same-key run stays blocked while keyless work can still be claimed
- however, low-level direct `claimNext()` races across multiple PostgreSQL clients are still not fully stable when tested in isolation

Implication:

- PostgreSQL still needs more design work if `QueueStore.claimNext()` itself is meant to be a first-class portable primitive for same-key serialization
- for now, the strongest confirmed guarantee is at the runtime level, not at the raw queue-primitive level

### libSQL

libSQL passed the current node-side semantics and stress suites.

Validated so far:

- idempotent enqueue
- single-winner claim
- stale renew rejection
- stale completion rejection after reclaim
- expired lease reclaim
- `startedAt` preservation
- multi-runtime stress against the same file-backed libSQL database

Current interpretation:

- no immediate semantic failure has been reproduced
- this is encouraging, but not yet enough to treat libSQL as semantically equivalent to PostgreSQL

Additional `concurrencyKey` exploration:

- same-key runs were not double-leased in the node-side direct-claim stress suite
- once one same-key run was leased, later same-key runs stayed blocked while unrelated work remained claimable
- separate runtimes did not execute same-key runs concurrently in the end-to-end runtime test

### Local SQLite (`better-sqlite3`)

Local SQLite passed the same semantics and stress suites as libSQL.

Validated so far:

- idempotent enqueue
- single-winner claim
- stale renew rejection
- stale completion rejection after reclaim
- expired lease reclaim
- `startedAt` preservation
- multi-runtime stress against the same WAL-backed SQLite file

Current interpretation:

- local SQLite remains a strong semantic fit for single-node execution
- unlike PostgreSQL, it did not force an adapter-specific claim shape in the current exploration

Additional `concurrencyKey` exploration:

- the generic claim path held up under the new same-key direct-claim stress tests
- separate runtimes did not execute same-key runs concurrently in the end-to-end runtime test

### SQLocal

SQLocal passed the browser-side semantics suite.

Validated so far:

- idempotent enqueue
- single-winner claim
- stale renew rejection
- stale completion rejection after reclaim
- expired lease reclaim
- `startedAt` preservation

Browser stress status:

- multi-runtime single-winner claim passed when multiple runtimes shared the same SQLocal database name
- reclaim-after-expiry did not pass under the current multi-runtime browser stress setup
- more specifically, an expired lease update written by one runtime did not become visible quickly enough to another runtime for reclaim to proceed in the test harness
- that reclaim stress case is currently kept out of the passing test set and treated as an unresolved browser-side limitation / investigation item

Current interpretation:

- SQLocal is good enough for the basic lease contract in browser tests
- the stronger reclaim scenario still has unresolved behavior in the browser multi-runtime setup
- this may be a real visibility/coordination limit, or a property of how SQLocal-backed runtimes synchronize within one browser context

Suggested product stance for browser-local mode:

- recommend a single active Durably runtime per tab
- document singleton creation as the default integration pattern
- add a development warning when the same browser-local database appears to be initialized by multiple Durably instances in one tab

Exploration result:

- a lightweight per-tab registry on `globalThis` is enough to warn on duplicate browser-local runtime creation
- the warning can be keyed either by explicit runtime configuration or by browser-local dialect metadata
- clearing the registry entry on `stop()` / `destroy()` avoids spurious warnings for normal remount and cleanup paths

Rationale:

- this avoids overselling browser multi-runtime reclaim semantics
- it gives users a simple integration rule that matches the strongest observed behavior
- it keeps Phase 1 focused on the core lease runtime instead of expanding into built-in tab coordination

### Test harness note

PostgreSQL required per-test schema isolation.

Without isolation, multiple test files sharing the same dockerized database produced false failures caused by test pollution rather than adapter semantics.

Implication:

- adapter validation needs backend-aware isolation rules
- some apparent semantic failures are really harness failures unless isolation is controlled first
