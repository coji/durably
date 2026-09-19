# ADR-0008: Active-run coalescing and scoped job tracking

## Status

accepted

## Context

Entity-oriented applications need to ensure that only one run for a job and entity is active at a time. The existing `coalesce: 'skip'` and `coalesce: 'queue'` modes preserve one pending run behind a leased predecessor, so they intentionally schedule trailing work instead of reusing the leased run.

React applications also need to resume and follow the run for one entity without manually looking up run IDs. Inputs are application payloads and are not indexed tracking metadata, while labels already have indexed, all-values-must-match filtering in storage and HTTP subscriptions.

Active selection must remain atomic with worker claiming. A read followed by an insert in a deferred SQLite transaction can race across runtime instances. PostgreSQL active batches and workers can also deadlock if they acquire concurrency-key advisory locks in opposite orders.

## Decision

Add `coalesce: 'active'`. After idempotency resolution, an active trigger selects the oldest pending run for the exact `(jobName, concurrencyKey)` pair, otherwise a leased run whose non-null lease expiry is later than the transaction timestamp, otherwise it inserts a pending run. Terminal runs and expired or null leases do not block insertion. The reused run is unchanged and the coalesced event reports its actual `pending` or `leased` status.

SQLite and libSQL active enqueue transactions perform a no-op write to `durably_runs` as their first statement. This obtains database write serialization before idempotency or active-run reads. Active batches do the same once at transaction start. A process-wide mutex prevents synchronous local SQLite busy waits from blocking another local connection that must commit; the database write remains the cross-process synchronization mechanism.

PostgreSQL active triggers use the same transaction-scoped advisory lock domain as worker claims. Active batches acquire distinct concurrency keys in sorted order before processing items. Workers use `pg_try_advisory_xact_lock`, skip unavailable keys for the current poll, and reconsider them on later polls. This avoids waiting for one key while retaining another key lock.

React `useJob` uses `scope.labels` as its tracking scope in both SPA and client modes. Every label must match. Scoped lookup prefers leased runs and then pending runs. SPA event following filters persisted event labels locally; client mode sends `label.<key>` parameters on lookups and subscriptions. Hooks follow matching `run:trigger`, `run:coalesced`, and `run:leased` events, expose the selected status immediately, and use `isResolving` to distinguish lookup from an idle result.

The selection is a database decision at one instant. A leased run returned by an active trigger may become terminal before the caller observes the response. An expired predecessor may also be reclaimed after an active trigger creates a pending replacement; both runs can then exist under the established lease recovery rules.

## Consequences

- Applications can deduplicate work while an entity-specific run is pending or validly leased without scheduling a trailing run.
- Existing `'skip'` and `'queue'` behavior and the pending-run partial unique index remain unchanged.
- Equal concurrency keys still exclude overlapping execution across different job definitions, while active coalescing only reuses runs from the same job definition.
- Scoped hooks can resume after remount and follow externally triggered work without application-managed run lookup plumbing.
- Scope labels and trigger labels remain independent; applications must supply both when a trigger should be visible to the scoped hook.
- PostgreSQL workers may skip a contended candidate for one poll, but the candidate remains eligible after the lock is released.

## Rejected Alternatives

### Change `'skip'` or `'queue'` to reuse leased runs

Rejected because both modes have established trailing-run semantics. Changing them would silently drop work that callers expect to run after the current lease.

### Derive React scope from job input

Rejected because inputs are arbitrary payloads and are not indexed for filtering. Labels provide an explicit, persisted, and transportable scope primitive.

### Accept arbitrary JavaScript scope predicates

Rejected because predicates cannot be represented consistently in SQL queries or HTTP subscriptions and would make cross-runtime behavior diverge.

### Add a new active status or queue table

Rejected because pending and leased already express the required lifecycle, and the existing schema can implement the selection atomically.

### Use blocking PostgreSQL advisory locks in worker claims

Rejected because a worker could retain one concurrency-key lock while waiting for another in the reverse order of an active batch, producing a lock-order deadlock.
