# Design: Database Claim Patterns

## Goal

This document describes concrete implementation patterns for lease claim and related mutations across different database adapters.

For more concrete PostgreSQL and SQLite query sketches, see `database-adapter-sketches.md`.

It is not intended to lock Durably into one exact SQL statement per backend.

Its purpose is to clarify:

- what kind of query shape is required
- what properties the adapter must preserve
- what patterns are too weak or too race-prone

## Scope

The focus is on four storage operations:

- `claimNext()`
- `renewLease()`
- `completeRun()` / `failRun()`
- idempotent `enqueue()`

Checkpoint and event persistence matter too, but the highest-risk adapter logic is usually in claim and lease ownership.

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
