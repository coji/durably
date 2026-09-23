# ADR-0016: Events follow state writes directly

## Status

accepted

## Context

Durably reports run and step state both in storage and through in-process events. Applications combine them: a UI polls `getRun()` and also listens for `run:fail` to show the failed step, and tests wait for a status and then inspect the events they collected.

The order between a state write and its event was never specified. `run:complete` was emitted right after `completeRun`, but `run:fail` waited for a `getStepAttempts` read after `failRun`, and `run:cancel` waited for checkpoint cleanup after `cancelRun`. A reader could see `failed` or `cancelled` a storage round trip before the event, and a test flaked on exactly that gap once CI retries were removed. A run whose job was not registered was failed with no event at all.

## Decision

A run or step state event is emitted directly after the storage write that makes the change, before the runtime accesses storage again. This covers `run:trigger`, `run:coalesced`, `run:leased`, `run:waiting`, `run:complete`, `run:fail`, `run:cancel`, `run:delete`, `step:start`, `step:complete`, and `step:fail`.

- Anything an event needs is known before the write or computed without storage. `run:fail` names the failed step from the failures the step context recorded under the current lease instead of reading attempts back.
- Terminal checkpoint cleanup (`preserveSteps: false`) starts after the event for every terminal state that cleans up; a failed `step.all()` with a successful branch keeps its checkpoints (ADR-0005). A cleanup failure after a committed cancellation is reported as `worker:error` rather than rejecting `cancel()`.
- A run whose job is not registered goes through the runtime kernel like any other run, so it emits `run:leased` and `run:fail`.
- A shared test records every storage call, resolution and event in one sequence and checks that each event is the next entry after its write, on SQLite, PostgreSQL and the browser.

The guarantee is one-directional and in-process. A concurrent reader can observe the new state just before the event is delivered, and other runtimes sharing the database receive no events. `step:cancel`, `log:write`, `run:progress`, and maintenance transitions (idle lease release and expiry failure, wait deadline expiry, retention purges) are outside it and documented as such.

## Consequences

- A listener that reads the run on a state event sees that state.
- Code that needs an event's payload must wait for the event, not for the state; the documentation says so.
- New state transitions must keep lookups and cleanup out of the gap between write and emit, and the ordering test catches a regression deterministically.
- Terminal cleanup starts once synchronous listeners return, for `run:cancel` as for `run:complete` and `run:fail`. Listeners are not awaited, so only a read started synchronously may still see the checkpoints; `preserveSteps: true` keeps them.

## Rejected Alternatives

### Emit from inside the storage transaction

Rejected because listeners run synchronously and could observe uncommitted state, or announce a change that then rolls back.

### Transactional outbox with guaranteed delivery

Rejected because events are an in-process notification mechanism. Cross-process delivery belongs to `waitForRun()` and the HTTP subscription endpoints, and an outbox would add a table, a relay and cleanup to every backend.

### Guarantee both directions

Rejected because a reader on another connection can see a committed row before the writing runtime resumes; closing that would need locking that every storage read pays for.

### Emit events for maintenance transitions

Deferred. Idle lease release, expiry failure, wait expiry and retention purges run as set-based SQL without per-run rows in hand. Emitting for them is a separate decision about the cost of returning affected rows.
