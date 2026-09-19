# ADR-0005: Parallel named steps and durable join

## Status

accepted

## Context

Independent tasks such as two code reviews should run concurrently within one logical run. If a worker stops after one review completes, the saved result must be reused while the unfinished review is retried. Each review also needs its own attempt and log attribution. Existing `step.run()` checkpoints and attempt records already identify work by name, but a shared `currentStepName` cannot attribute logs safely during concurrent callbacks. A caller can use `Promise.all()`, but its fail-fast behavior may let the parent run finalize before a sibling settles.

## Decision

Add `step.all({ name: callback })`. Each branch invokes the existing `step.run()` machinery concurrently, so checkpoint replay, attempt recording, lease fencing, and cancellation retain their current semantics. Branch names are stable step names within the job; numeric indexes reflect the order branches start after asynchronous checks, not necessarily object key order. The join uses all-settled behavior: it returns named results after all branches succeed, or waits for all branches to settle before throwing an error. Lease loss and cancellation take precedence over ordinary branch failures; with multiple ordinary failures, the lowest-index failed checkpoint determines the error, matching `run:fail.failedStepName`. A business verdict such as “changes requested” is a returned value, not an execution error. This API does not suspend the run or release its worker slot; external waits remain the separate concern of #188.

Expose `attempt.log` for callback-scoped attribution. Shared `step.log` keeps its existing step name for a single callback or a sequentially nested callback chain, but after independent callbacks overlap emits unscoped logs until all active callbacks settle. This prevents late logs from a completed callback being attributed to its still-running sibling. Attempt timestamps allow per-branch measurement and group wall-clock measurement without recording a second aggregate attempt.

## Consequences

- Completed branches are replayed without new attempts after lease recovery; unfinished branches get new attempts.
- A failing branch does not erase a sibling's attempt or completed output. The run fails only after siblings settle. If at least one branch succeeds, the failed run retains its checkpoints and logs even with `preserveSteps: false`, so the successful result remains inspectable. Other terminal runs use normal cleanup; `preserveSteps: true` retains all terminal checkpoints.
- Branch callbacks that ignore cancellation can delay the join, as with an ordinary long-running step.
- Users must keep branch names stable across retries and use `attempt.log` for reliable log attribution during parallel work.

## Rejected Alternatives

### Parent and child runs

Rejected for this scope because a parent waiting on child runs can occupy the worker's available slots. Durable suspension is a separate design issue (#188).

### `Promise.all()` as the documented join

Rejected because it rejects before sibling callbacks finish, allowing the parent run to finalize while sibling writes are still in flight.

### Async-local step attribution

Rejected because Durably also runs in browsers and should not require Node-specific async context for log correctness.
