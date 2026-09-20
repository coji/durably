# ADR-0010: Durable external waits

## Status

accepted

## Context

Jobs waiting for CI or human input currently retain a worker slot, and an ordinary unresolved Promise cannot survive a process restart. Issue #200 implements the direct-API core of #188. Deadlines and dedicated HTTP wait endpoints are separate follow-up decisions.

A signal may arrive before a job suspends. A resumed run may also coexist with a trailing pending run for the same job and concurrency key. The pending partial unique index prevents treating every resume as a new pending run.

## Decision

Persist waits identified by run ID and a stable, application-supplied name. `step.prepareWait()` commits an input address before external work starts; `step.waitFor()` consumes a persisted signal or requests suspension at a sequential job boundary. `durably.signal()` accepts the first input and makes retries with the same signal ID and payload idempotent. Unknown addresses and conflicting inputs are rejected. Wait results and metadata survive checkpoint cleanup and are deleted with their run.

Add a nonterminal `waiting` run status. Suspension returns control to the runtime before releasing the lease and worker slot. Resume obtains a fresh fenced lease and replays the job from the beginning using completed named step results. Neither JavaScript stacks nor arbitrary user code are suspended in place. Step callbacks and parallel branches cannot suspend, and a suspension cannot leave a callback running after the slot is returned.

Only the wait currently awaited by a run makes that run eligible for resume. Persisted results are authoritative; events accelerate observation. Resolved waiting runs are claimed directly without passing through pending. Recovery of a previously suspended run must remain possible after another crash even when a trailing pending run exists, including idle expired-lease maintenance. Cancellation is terminal and cleans checkpoints without requiring a worker.

Waiting releases same-key execution exclusion. Resumption still honors valid same-key leases. Application-owned resource reservations are separate from this execution limit. Candidate order remains creation time and ID; this decision adds no strict fairness guarantee.

Extend the active selection from ADR-0008 to pending, then valid leased, then waiting runs for the same job/key. Its rejection of an additional status applied to active coalescing alone; durable suspension now requires one. Other ADR-0008 decisions remain applicable, including atomic selection, pending-only skip/queue behavior, labels, and lock ordering. React auto-resume searches leased, pending, then waiting. Preserve `isActive` as pending/leased and expose `isWaiting`; unfinished runs are identified with `!isTerminal`.

## Consequences

- External input survives restarts and can arrive before suspension without being lost.
- Sequential jobs can release scarce execution capacity while retaining their run identity and checkpoints.
- The public status union and existing HTTP/React observation paths must support waiting in this implementation.
- Applications own signal authorization, payload validation, stable iteration names, and external-operation idempotency. Checkpoint replay does not promise exactly-once external effects.
- Durable deadlines, parallel waits, arbitrary pre-registration mailboxes, and HTTP signal endpoints remain outside this decision.

## Rejected Alternatives

### Keep an unresolved Promise in the worker

It retains capacity and cannot survive process termination.

### Register the wait after starting external work

A fast external result can arrive before a durable input address exists.

### Return every resolved wait to pending

A trailing pending run may already occupy the partial unique index entry. A direct resume path preserves both runs.

### Release the lease before the job returns to the runtime

Another worker could resume while old catch/finally code is still executing. The handoff must follow runtime control recovery.

### Keep the execution concurrency key reserved while waiting

This prevents same-key work from using the released capacity. Business reservations need an explicit application-owned lifetime.
