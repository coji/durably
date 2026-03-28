# Spec Review Procedure

Review the task spec (order.md) and the existing code targeted for changes.

## Steps

1. Read order.md and verify the following:
   - Whether the implementation details are clear
   - Whether the files to change are comprehensive (including implicit dependencies)
   - Whether the completion criteria are verifiable
   - Whether the out-of-scope section is clear

2. Actually read the files to change and understand the existing code structure

3. If a supervise report exists (`supervise-report.md`), read it and incorporate its findings into the review

4. Review from the following perspectives:
   - Are any files to change missing?
   - Are the completion criteria sufficient (edge cases, error handling)?
   - Is the scope appropriate (not too large/too small)?
   - Can existing patterns or utilities be leveraged?

5. Check for common spec omissions:

   **Input validation:**
   - New public API options used as counts, concurrency limits, or loop bounds: spec must define the exact valid domain (e.g., "positive safe integer"), not just "number". Tests must cover 0, negative, NaN, Infinity, fractional, and > MAX_SAFE_INTEGER.
   - Async operations in intervals/loops: is there a guard against concurrent in-flight requests?

   **Concurrency and scheduling:**
   - If the spec changes polling, scheduling, or concurrency behavior: completion criteria must cover both safety (no overlap, no double-execution) AND liveness (idle resources keep polling, freed slots are reused, new work is picked up within bounded delay).
   - Require explicit criteria for each state transition: work found → immediate action, partially idle → keeps polling, fully idle → maintenance + delayed poll, error/reject → no orphaned state, stop → predictable drain.

   **Promise and async ownership:**
   - If the design creates promises that are not directly awaited at the creation site (detached/tracked promises): spec must define who owns cleanup and rejection handling. Require a test that rejected callbacks do not produce unhandled rejections.
   - stop()/shutdown methods that await tracked promises: spec must require Promise.allSettled (not Promise.all) or equivalent, so a single rejection doesn't prevent cleanup of other in-flight work.

   **Documentation and examples:**
   - Code examples in docs/examples: do they demonstrate the API correctly without redundant checks?

   **Behavioral preservation:**
   - Existing behaviors that must be preserved: are they listed as explicit completion criteria with negative test cases?
   - When changing worker/scheduler behavior: require at least one completion criterion that states what must not regress, with a negative or regression test.

## Routing Guide

- **spec-revise** (blocking issues): The spec has concrete problems that can be fixed by editing order.md — missing files, unclear criteria, scope gaps, contradictions between sections
- **implement** (no blocking issues): The spec is clear enough to implement. Suggestion-level improvements can be noted but do not block
- **ABORT** (fundamentally broken): The task itself is incoherent — e.g., the requested change contradicts the project's architecture, the task duplicates already-completed work, or the goal cannot be achieved with the described approach and no alternative is apparent
