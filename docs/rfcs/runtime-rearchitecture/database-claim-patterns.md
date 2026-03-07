# Design: Database Claim Patterns

## Goal

This document describes concrete implementation patterns for the adapter-internal lease claim path and related mutations across different database adapters.

For more concrete PostgreSQL and SQLite query sketches, see `database-adapter-sketches.md`.

It is not intended to lock Durably into one exact SQL statement per backend.

Its purpose is to clarify:

- what kind of query shape is required
- what properties the adapter must preserve
- what patterns are too weak or too race-prone

## Scope

The focus is on four adapter operations:

- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`
- idempotent `enqueue()`

Checkpoint and event persistence matter too, but the highest-risk adapter logic is usually in claim and lease ownership.

This document is for adapter implementors.
It does not define the primary runtime contract exposed to application code.
At the runtime level, the portability target is `processOne()` and the lease semantics around it.
`claimNext()` exists here as an internal building block whose exact shape may vary by backend.

## Shared Rule

The adapter must preserve this invariant:

At most one worker may successfully acquire or extend active execution authority for a run at a given time.

This means:

- claim must be exclusive
- renew must be conditional on current ownership
- complete and fail must be conditional on current ownership
- reclaim must be part of normal claim behavior

## What To Avoid

These patterns are not sufficient on their own:

- select a pending row, then update it in a separate non-guarded write
- read ownership into application memory, then complete later without re-checking
- depend on in-memory locks between workers
- treat queue delivery as proof of ownership
- assume low contention means race conditions can be ignored

The adapter must defend correctness even under real races.

## PostgreSQL Patterns

PostgreSQL is the cleanest reference model.

### `claimNext()`

The desired shape is:

1. find one claimable run inside a transaction
2. lock the candidate row
3. update the same row to `leased`
4. return the claimed row

In practice this usually means a pattern based on:

- `FOR UPDATE SKIP LOCKED`
- ordered selection of one candidate
- guarded update inside the same transaction

This works well because PostgreSQL gives a clear row-locking model for concurrent workers.

#### Exploration Note

This is not just a stylistic preference.

During Phase 1 adapter exploration, PostgreSQL was able to produce double winners when it was forced through a generic SQLite-shaped conditional update path.

That means:

- PostgreSQL needs a dedicated claim strategy
- "generic SQL claim" should not be treated as a first-class portability goal
- PostgreSQL correctness should be argued from row locking semantics, not from hoping a subquery update races safely

Phase 1 also showed a second boundary:

- even when runtime-level `processOne()` semantics are defensible, a raw portable `QueueStore.claimNext()` primitive may still be too weak a portability target

That reinforces the intended layering:

- `processOne()` is the core runtime contract
- `claimNext()` is adapter machinery used to implement it

### `renewLease()`

Use a guarded update of the form:

- `WHERE id = ?`
- `AND status = 'leased'`
- `AND lease_owner = ?`
- optionally `AND lease_expires_at >= now`

Renew should succeed only if exactly one row was updated.

### `completeRun()` / `failRun()`

Use the same guarded-update shape:

- match by `id`
- require `status = 'leased'`
- require `lease_owner = workerId`

If zero rows are updated, the worker has lost authority and must treat completion as rejected.

### Idempotent `enqueue()`

Use a unique constraint on `(job_name, idempotency_key)` when the key is present, plus conflict-aware insert behavior.

### Why PostgreSQL Is the Reference

The semantics are explicit enough that adapter correctness can be argued in terms of transactions and row locks rather than informal timing assumptions.

## SQLite Patterns

SQLite can preserve the required semantics, but the shape is different because the concurrency model is different.

### `claimNext()`

The desired shape is:

1. start a write transaction
2. select one claimable run
3. update that row to `leased` within the same transaction
4. commit

Because SQLite serializes writers more aggressively, correctness comes more from transactional write exclusion than from row-level locking.

This is acceptable for single-node and tightly-contained deployments.

### `renewLease()`

Use a guarded update with:

- `id`
- `status = 'leased'`
- `lease_owner = workerId`

Treat success as "row count updated equals one."

### `completeRun()` / `failRun()`

Use the same ownership-sensitive guarded update pattern.

### Idempotent `enqueue()`

Use a unique index plus conflict-aware insert behavior, not a read-then-insert race.

### Main Caveat

SQLite correctness is easier to defend than SQLite scale.

The adapter is viable, but should be framed as strongest in single-machine or tightly-controlled write environments.

#### Exploration Note

The current local SQLite exploration passed the same basic claim and reclaim tests that were used for PostgreSQL and libSQL comparison.

That supports the current stance:

- SQLite can be a strong semantic target
- but it should be presented as a single-node semantic anchor, not as the universal concurrency model

## libSQL Patterns

libSQL should begin from the SQLite query shape, but should not be assumed equivalent in practice.

### `claimNext()`

The intended pattern is still:

1. begin transaction
2. select one claimable run
3. update that run inside the same transaction
4. commit

### What Must Be Verified

The adapter must validate:

- transactional visibility under concurrent remote workers
- write serialization behavior
- whether the chosen transport and deployment mode preserve the claim guarantees assumed by the adapter

### `renewLease()` and Completion

These should remain guarded updates exactly as with SQLite and PostgreSQL:

- match run id
- require leased status
- require current owner

### Main Caveat

Surface compatibility is not enough.

If concurrency behavior differs meaningfully from local SQLite assumptions, the adapter must document that difference and may need stricter support boundaries.

#### Exploration Note

The current libSQL exploration passed the shared semantics and stress suites used in Phase 1.

That is a positive signal, but it should still be interpreted as:

- "no failure reproduced in current adapter tests"

not:

- "proven equivalent to PostgreSQL under all claim and reclaim conditions"

## Cloudflare D1 Patterns

D1 should be treated as a platform-shaped adapter, not just "SQLite in the cloud."

### `claimNext()`

The desired logical shape remains:

1. transactionally identify one claimable run
2. conditionally mutate it to leased
3. return success only for the winner

### What Must Be Verified

The adapter must prove, with tests under contention, that:

- two workers cannot both believe they claimed the same run
- reclaim behaves predictably after expiry
- conditional completion reliably rejects stale workers

### `renewLease()` and Completion

Use strict conditional writes based on:

- run id
- leased status
- lease owner

### Main Caveat

If the backend's practical transaction behavior is hard to reason about, adapter confidence must come from targeted concurrency tests rather than assumptions borrowed from local SQLite.

## Alternative Claim Shape

Some backends may prefer a single conditional `UPDATE ... WHERE id = (subquery)` style over an explicit select-then-update transaction.

That is acceptable if it preserves the same semantics:

- one winner under race
- no stale ownership extension
- predictable reclaim after expiry

The exact SQL shape may vary. The semantic contract may not.

However, Phase 1 exploration showed a hard boundary:

- this generic shape should not be assumed safe on PostgreSQL

If a backend cannot defend exclusivity with that shape under contention, it needs a backend-specific claim path.

## Reclaim Semantics

Regardless of database, `claimNext()` should treat these runs as claimable:

- `pending`
- `leased` with `leaseExpiresAt < now`

This means reclaim is not a repair path. It is ordinary claim logic.

The query shape should not require a separate "recover first, then claim later" workflow.

## Started Time Rule

Claim implementations should preserve `startedAt` correctly:

- set it on first claim
- preserve it on later reclaim

This is a small detail, but it matters for run history and operational visibility.

## Recommended Adapter Test Cases

Every database adapter should be tested for at least these cases:

- two workers race to claim the same run and only one wins
- a worker cannot renew another worker's lease
- a stale worker cannot complete a reclaimed run
- an expired leased run can be reclaimed
- idempotent enqueue creates exactly one run
- reclaim preserves the original `startedAt`

These tests matter more than whether two adapters use similar SQL syntax.

## Practical Guidance

Durably should treat PostgreSQL as the semantic reference point.

Then:

- map SQLite to the same behavioral contract with a different locking model
- validate libSQL against that contract rather than assuming equivalence
- validate D1 as a platform-specific adapter under contention

This keeps the portability story honest.
