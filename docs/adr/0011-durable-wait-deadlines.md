# ADR-0011: Durable wait deadlines and lifecycle timing

## Status

accepted

## Context

ADR-0010 adds durable external waits, but an unanswered wait can remain suspended indefinitely. A caller-side `waitForRun()` timeout does not end the durable wait and cannot express a restart-safe business deadline. Direct wait records also cannot separate time awaiting external input from time awaiting execution capacity after input has arrived.

Signal delivery, deadline evaluation, and cancellation may occur in different runtimes at the same time. A result must remain stable across replay and restarts, and a cancelled run must never resume because a result was finalized.

## Decision

Add optional `timeoutMs` to `step.prepareWait()`. Require a positive safe integer in milliseconds and a resulting deadline within the representable date range. The first preparation persists an absolute deadline; replaying the same run/name returns that deadline even if later code changes the option. Omitting the option creates an unbounded wait. A deadline is a property of this one wait, not a general timer or job retry policy.

Persist one immutable result with an outcome of `signal` or `timeout`. `step.waitFor()` returns a discriminated signal/payload or timeout result. A timeout is ordinary job input so the job chooses its branch. A new signal wins only if its authoritative transaction time is strictly before the deadline. At or after the deadline, signal delivery first finalizes an unresolved wait as timed out and rejects the new input, even if no worker has swept it. An identical retry of an already accepted signal returns its original receipt after the deadline or run cancellation.

Serialize signal, timeout, and cancellation changes in database transactions, locking the run before the wait on backends with row locks. Conditional writes allow only a pending wait to be finalized. Cancellation remains terminal even when a signal or timeout result has already been recorded; replay checks the current lease and cancellation state before subsequent step work. A finalized wait never revives a cancelled run.

Worker polling and manual processing evaluate due waits, including deadlines crossed while all workers were stopped. Deadline finalization makes only the currently awaited waiting run eligible for a new fenced lease. Resumption uses ADR-0010 checkpoint replay on the same run ID and respects any valid same-concurrency-key lease. One runtime keeps at most one expiry sweep in flight, and sweep failures join the worker's error path.

Persist preparation, suspension, result-finalization, and first-resume timestamps. For a suspended wait, input-wait duration runs from suspension to signal acceptance or the persisted deadline, floored at zero when the result is finalized during the suspension handoff. Post-result execution-slot duration runs from the later of result finalization and suspension until the first resumed lease. A result consumed without suspension reports zero for both durations; a result finalized just before the handoff can have zero input wait and positive slot wait. An unresolved input wait and a suspended result that has not resumed retain `null` for their respective duration. These are direct per-wait measurements, not a claim about external operation time or aggregate queue latency.

## Consequences

- The first deadline survives replay and restart without extension. Existing unbounded waits remain valid.
- A timeout branch can proceed after restart without a separate signal sender. The job still needs idempotent external effects and explicit handling of its timeout result.
- Direct wait reads distinguish input delay from post-result execution-capacity delay. The latter can increase while another same-key run owns a valid lease.
- A sender must use a stable `signalId` and payload when retrying an uncertain delivery; a newly delivered signal at the deadline is rejected.
- Dedicated HTTP wait and signal endpoints remain outside this decision.

## Rejected Alternatives

### Start the timeout when `waitFor()` suspends

External work may begin after `prepareWait()` but finish or time out before suspension. Starting later would silently extend the business deadline and make replay dependent on worker scheduling.

### Accept a signal based on a sender-provided timestamp

Senders can have different clocks or replay stale claims. The database transaction's authoritative time determines the deadline boundary.

### Mark the run failed automatically on timeout

A missing approval or CI result is application data. Returning a distinct timeout result lets the job choose a fallback, fail explicitly, or complete.

### Measure all wait time as one duration

That would obscure whether input delivery or available execution capacity dominates latency, especially when a concurrency-key peer occupies the slot after the result is known.
