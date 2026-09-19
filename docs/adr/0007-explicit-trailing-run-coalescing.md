# ADR-0007: Explicit trailing run coalescing

## Status

accepted

## Context

Callers orchestrating fan-out producers and consumers often encounter the case where a producer produces new work while a consumer with the same `concurrencyKey` is already actively running (leased). To avoid losing newly produced data, callers need to preserve one subsequent consumer execution that runs after the active run completes.

The existing database schema and storage engine already support this model: SQLite and PostgreSQL enforce a partial unique index on `(job_name, concurrency_key)` only for runs where `status = 'pending'`. Consequently, one leased run and one pending run can coexist for the same concurrency key. Under `coalesce: 'skip'`, if a leased run exists and no pending run exists, triggering with the same concurrency key creates a trailing pending run; if a pending run already exists, it reuses that pending run.

However, the option name `'skip'` obscures this capability. Callers perceived `'skip'` as merely discarding work, making it unintuitive for queueing a trailing execution. Callers requested an explicit, intent-revealing option to preserve one trailing run.

## Decision

Expose `'queue'` as a valid value for the `coalesce` option across `trigger()`, `triggerAndWait()`, `batchTrigger()`, and the HTTP trigger endpoint (`coalesce?: 'skip' | 'queue'`).

In this release, `'queue'` and `'skip'` are behaviorally equivalent aliases:

- When only a pending run exists for the same `jobName` and `concurrencyKey`, both reuse the existing pending run (disposition `'coalesced'`), without overwriting the pending run's input, labels, or idempotency key.
- When an active (leased) run exists and no pending run exists, both create a single trailing pending run (disposition `'created'`).
- When both a leased run and a pending run coexist, further triggers reuse the trailing pending run (disposition `'coalesced'`). The unused input and labels are reported exclusively through the `run:coalesced` event.
- At most one pending run is permitted per `jobName` and `concurrencyKey`.
- An idempotency-key match returns disposition `'idempotent'` before concurrency conflict resolution.
- Neither the `'skip'` behavior nor the worker claim algorithm is modified. Active-run coalescing remains separate under issue #185 and is not promised or implied here.

## Consequences

- Callers can explicitly express their intent to schedule a trailing run using `coalesce: 'queue'` instead of relying on the unintuitive `'skip'` name.
- No database migrations, schema additions, or new run statuses are required. The partial unique index continues to protect concurrency boundaries.
- Reusing an existing pending run retains its original input and labels; callers must handle any batch accumulation or state merging in application logic if needed.
- Lease expiry recovery remains consistent: if a leased predecessor's lease expires while a trailing pending run exists, the predecessor fails with a conflict error rather than resetting to pending.

## Rejected Alternatives

### Change `'skip'` behavior directly to coalesce onto active leased runs

Rejected because `'skip'` already has established, documented semantics. Altering `'skip'` to coalesce directly onto an active run without creating a trailing execution would break existing workflows. Active-run coalescing is tracked separately in issue #185.

### Introduce a new `'queued'` run status or dedicated queue table

Rejected because durably's minimal design leverages the existing `'pending'` state and partial unique index. A separate status or table would introduce unnecessary state transitions, migrations, and runtime complexity without delivering additional execution guarantees.

### Support unbounded queueing or configurable `maxQueued`

Rejected because Durably is designed for single trailing execution coalescing per concurrency key. Buffering multiple inputs would require queue persistence, backpressure handling, and complex replay semantics that fall outside the framework's minimalist scope.
