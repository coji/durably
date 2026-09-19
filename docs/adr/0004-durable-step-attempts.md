# ADR-0004: Durable step attempt records

## Status

proposed

## Context

A step checkpoint is written only after its callback settles. If a worker disappears during a long-running callback, the callback may have consumed time or external resources but no checkpoint or durable start record remains. An in-process `step:start` listener cannot guarantee that its asynchronous write commits before the callback begins. Replaying a completed checkpoint must also remain distinct from invoking a callback again.

Checkpoint output and execution measurement have different retention needs. The default `preserveSteps: false` removes checkpoints at a terminal run state, but measurement must remain available until the run itself is deleted or purged. This revisits the narrower need left out of the broad execution-history proposal in #162.

## Decision

Add a separate `durably_step_attempts` table. A new row with a stable ID, run/step identity, lease generation, start time, and optional JSON metadata commits before each actual callback invocation. Completed checkpoint replay creates no attempt. The callback can replace its metadata through an awaited, lease-guarded write. Replacement, rather than additive updates, lets consumers aggregate per attempt ID without double-counting a retried metadata update.

When a callback settles, its attempt outcome and the existing step checkpoint commit in one transaction. A stale lease owner cannot update metadata or finalize either row. An attempt left without a confirmed outcome remains unresolved; its interruption reason is inferred from persisted run state and lease generation. Durably does not claim to know when a crashed callback stopped or how much an external provider consumed.

Attempts survive terminal checkpoint cleanup and are deleted with their run by explicit deletion or retention-based purge. Metadata is application-owned JSON; model names, usage formats, pricing, and analytics stay outside Durably. SQLite uses a single conditional write statement for begin/update to serialize with cancellation and claim; PostgreSQL locks the run row before touching an attempt.

Parallel callbacks reserve distinct step indexes before invocation. Replaying a completed checkpoint uses its persisted index instead of counting it again, and checkpoint persistence never moves the run's index backward when parallel callbacks finish out of order. Run deletion locks the run row before deleting its attempts, matching the mutation lock order.

## Consequences

- A crash can leave an unresolved attempt that remains queryable after recovery.
- The new table adds one start write and one finalization write per executed step, plus any explicit metadata replacements.
- Attempt data remains until its run is deleted or purged, independently of `preserveSteps`. `retainRuns` and purging apply only to terminal runs; a continually reclaimed run must be cancelled to stop accumulating new attempts.
- A persisted start proves Durably was about to invoke the callback, not that an external service accepted work; exactly-once side effects remain an application concern.

## Rejected Alternatives

### Persist only `step:start` events through a listener

Rejected because the event emitter does not await asynchronous listeners, so callback invocation can precede the write.

### Add attempts to the checkpoint table

Rejected because checkpoint replay and measurement have different identities and retention. Reusing the same rows would make cleanup and repeated attempts ambiguous.

### Record every runtime event as a general execution log

Rejected because #186 needs a bounded, queryable record per actual callback invocation, not a general event-sourcing system.
