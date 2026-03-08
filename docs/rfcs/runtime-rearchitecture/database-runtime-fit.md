# Design: Database Runtime Fit

## Goal

This document evaluates how different databases fit Durably's runtime model.

For concrete claim and lease-mutation implementation patterns by database, see `database-claim-patterns.md`.

It focuses on one question:

Can a database preserve the execution semantics that Durably requires?

This is primarily about correctness, not raw performance.

## Why This Matters

Durably is a lease-based, checkpointed runtime centered on the database.

That means the database is not just a persistence layer. It is responsible for preserving execution authority and resumability.

A database is a good fit only if it can support the required semantics without fragile application-level workarounds.

Phase 1 exploration also clarified a migration constraint:

- if the runtime model changes materially, clean-break schema migrations are acceptable
- database fit should be judged on whether the new lease model can be expressed cleanly, not on whether every legacy column can be preserved cheaply

## Required Storage Semantics

Any first-class database target must support these semantics clearly and defensibly.

### 1. Acquire a Run Atomically

The store must be able to, in one atomic operation:

- choose one available run
- transition it to `leased` (mark it as "being executed")
- set `leaseOwner` and `leaseExpiresAt`
- ensure that only one worker wins when multiple compete

### 2. Only the Current Owner Can Modify a Run

The store must be able to renew, complete, and fail a run only if:

- the run is still leased
- the requesting worker still owns that lease

A worker whose lease has expired must not be able to renew or complete runs that another worker has taken over.

### 3. Safely Recover Abandoned Runs

The store must support recovery after lease expiry as part of the normal acquisition flow.

This means later workers must be able to safely continue after:

- crashes
- restarts
- timeouts
- network loss

### 4. Persist Step Results Durably

The store must persist completed steps durably enough that re-execution can:

- detect already-completed steps
- return prior outputs
- avoid redoing completed work

### 5. Prevent Duplicate Runs at the Storage Level

If idempotency keys are supported, they must be enforced by storage constraints or conflict-aware writes.

Read-then-insert races are not sufficient.

### 6. Append Logs and Events Efficiently

The store should make it practical to append:

- logs
- progress updates
- durable event-stream entries

These writes do not all need to be globally ordered, but they must be reliable and queryable.

### 7. Predictable Transaction Behavior

The store must expose transaction and isolation behavior that is clear enough to reason about concurrent acquisition and conditional writes.

If the semantics are opaque or unexpectedly weak, the adapter becomes hard to defend.

## Evaluation Criteria

For design purposes, each database should be judged on:

- claim correctness
- multi-worker safety
- serverless connectivity fit
- write-path cost for checkpoints and events
- operational simplicity
- portability of semantics across environments

## PostgreSQL

PostgreSQL is the clearest first-class fit.

### Why It Fits

- atomic claim patterns are well understood
- conditional updates and ownership-sensitive completion are straightforward
- transactions and row-level locking semantics are mature
- idempotency constraints are easy to express
- append-heavy event and checkpoint writes are natural
- multi-worker and multi-process coordination is a normal use case

### Exploration Result

Phase 1 adapter exploration confirmed an important detail:

- a generic SQLite-shaped `UPDATE ... WHERE id = (subquery)` claim pattern was not sufficient on PostgreSQL under concurrent claim attempts
- PostgreSQL required a dedicated claim path based on row locking semantics such as `FOR UPDATE SKIP LOCKED`

This matters because it means PostgreSQL should not be treated as "just another SQL backend" behind one generic claim query shape.

Phase 1 also clarified that `FOR UPDATE SKIP LOCKED` alone was not enough for `concurrencyKey` safety.
The PostgreSQL-specific path needed per-key advisory-lock serialization plus an in-transaction retry loop so that same-key conflicts did not suppress unrelated claimable work.

### Best Fit Profile

- multi-worker deployments
- serverless platforms with an external database
- higher write concurrency
- systems that want the least semantic ambiguity

### Main Tradeoff

Operationally heavier than embedded SQLite.

### Conclusion

PostgreSQL should be treated as a primary target and likely the reference model for storage semantics.

### DX Note

PostgreSQL is the strongest semantic reference, but it is not necessarily the best default onboarding story for individual developers if `Vercel + Turso` is the intended first experience.

It is, however, a very important target for production-oriented paths such as `Vercel + PostgreSQL` and `Fly.io + PostgreSQL`.

## SQLite

SQLite is a strong fit for single-node or tightly-contained deployments, but its boundaries should be explicit.

### Why It Fits

- transactions are strong and understandable
- atomic claim is implementable
- checkpoint persistence is simple
- local durability is excellent for embedded or single-machine use
- operational overhead is minimal

### Where It Fits Best

- local development
- single-tenant deployments
- desktop or edge-adjacent applications
- single-machine workers

### Main Constraints

- write concurrency is limited compared with PostgreSQL
- multi-writer scaling is not the natural shape
- distributed ownership across machines is not the default assumption
- deployment patterns that hide the file behind replication or proxy layers may change practical semantics

### Exploration Result

Phase 1 adapter exploration against local SQLite passed the current semantics and stress suites:

- single-winner claim
- stale renew rejection
- stale completion rejection after reclaim
- reclaim preserving `startedAt`

That reinforces the current positioning: SQLite is a strong semantic fit for single-node execution, even if it should not be generalized into the distributed reference model.

Phase 1 also confirmed that destructive rebuild migrations are viable here.
The old `heartbeat_at` column could be removed by rebuilding the runs table without weakening the lease-based model.

### Conclusion

SQLite should remain a first-class target for local and single-node execution, but it should not be used as the mental model for all deployments.

## libSQL

libSQL is promising because it preserves much of the SQLite programming model while allowing remote deployment.

### Why It May Fit

- familiar SQLite-compatible model
- easier serverless connectivity than file-based SQLite
- useful for products that want SQLite ergonomics with hosted access

### Why It Needs Care

- Durably depends on lease claim semantics more than on SQL syntax compatibility
- remote or replicated execution characteristics matter more than surface compatibility
- the exact guarantees around write serialization, visibility, and failure recovery must be validated through adapter-level tests

### Exploration Result

Phase 1 adapter exploration against libSQL passed the current semantics and stress suites used for local SQLite and PostgreSQL comparison.

That is encouraging, but it should still be interpreted carefully:

- no semantic failure has been reproduced in the current adapter tests
- this is not the same as proving libSQL is interchangeable with PostgreSQL as a semantic reference backend
- support language should remain "validated by adapter tests" rather than "assumed equivalent to SQLite"

### Best Fit Profile

- products that want a SQLite-shaped developer experience
- deployments that need an external DB for serverless environments
- moderate workloads where semantic validation has been done
- low-friction onboarding paths such as `Vercel + Turso` or `Cloudflare Workers + Turso`

### Conclusion

libSQL should be considered a plausible target, but not assumed equivalent to local SQLite. It belongs in a "supported with careful semantic validation" category unless proven otherwise by adapter tests and operational experience.

### DX Note

Even with the semantic caveats, libSQL has a strong claim to be the most approachable serverless-friendly starting point for solo developers because it keeps the mental model close to SQLite.

## Cloudflare D1

D1 may be a useful platform-specific target, but it should be approached conservatively.

### Why It Is Attractive

- natural fit for Cloudflare-hosted applications
- simple deployment story for Worker-based systems
- SQLite-flavored model

### Why It Is Riskier

- Durably needs strong confidence in claim exclusivity and ownership-sensitive updates
- platform-specific database behavior can be harder to reason about than mainstream PostgreSQL semantics
- the runtime model depends on predictable behavior under contention, retries, and reclaim

### Best Fit Profile

- Cloudflare-specific applications
- lower to moderate contention workloads
- cases where D1-specific constraints are acceptable and well tested

### Conclusion

D1 is better treated as a platform adapter target than as a universal reference model. It may be viable, but should likely start in a caveated category rather than a primary one.

## What Matters More Than Syntax Compatibility

Two databases may support similar SQL syntax and still differ meaningfully for Durably.

The important questions are not:

- does it speak SQLite syntax
- does it support JSON columns
- does it have `returning`

The important questions are:

- can run acquisition be made truly exclusive
- can expired workers be rejected reliably
- can lease expiry and recovery be reasoned about clearly
- can checkpoints and events be written frequently without fragile coordination

Durably should optimize for semantic portability, not superficial API similarity.

One practical consequence from exploration is:

- PostgreSQL may need a different claim implementation than SQLite-like backends
- browser-local SQLite-shaped runtimes may support the basic lease contract while still having weaker multi-runtime reclaim behavior

Semantic portability does not mean one SQL statement fits every backend.

## Recommended Support Tiers

The following tiering is a reasonable starting point.

### Primary Targets

- PostgreSQL
- SQLite

These are the clearest semantic anchors:

- PostgreSQL for distributed and serverless-connected deployments
- SQLite for embedded and single-node deployments

### Plausible Targets With Caveats

- libSQL
- Cloudflare D1

These should be supported only if adapter tests demonstrate that claim, renew, complete, and reclaim semantics remain defensible.

For browser-local SQLite-shaped runtimes such as SQLocal, the support story should be even narrower:

- basic single-runtime lease semantics can be supported
- multi-runtime reclaim semantics should be treated as caveated until validated more strongly

### Not a First-Class Promise

Any database whose transactional and conditional-write behavior cannot be clearly mapped to Durably's lease semantics should not be presented as first-class, even if basic persistence works.

## Adapter Design Implication

Durably should not present database support as a generic "works anywhere with SQL" claim.

Instead, each adapter should be judged by whether it can uphold:

- atomic claim
- lease-owner-sensitive mutation
- durable checkpoints
- reliable idempotency
- predictable reclaim

That is the real compatibility contract.
