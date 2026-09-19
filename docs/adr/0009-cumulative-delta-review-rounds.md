# ADR-0009: Cumulative delta review rounds

## Status

accepted

## Context

ADR-0003 requires a new complete review round after every fix so that a previous GO cannot be reused for a changed pull request head. The first review of a feature covers its full diff. Repeating that full exploration after every small fix is expensive and can keep finding new edge cases without improving coverage of the changed behavior. Reviewers still need to detect regressions introduced by a fix and verify that earlier blockers are gone.

## Decision

Keep the independent Codex and Opus tracks and a fresh GO/NO-GO decision for every pushed head. The first round reviews the full pull request diff. Later rounds review the cumulative delta from the last completed full-diff review, all affected callers and invariants, and the full trigger set of every unresolved blocker. Each round records which acceptance checks were reverified and which were carried forward from the earlier full review.

Run another full-diff review when a fix changes feature scope or architecture, or invalidates the earlier coverage. A changed head never inherits a previous GO; exact-head validation and CI remain required before Ready.

## Consequences

- Small fixes can converge without repeatedly rediscovering unchanged code.
- The cumulative delta and carry-forward ledger make review coverage auditable.
- Reviewers must trace affected behavior, not only the changed lines or newly added test.
- A major change still pays the cost of a full review.

## Rejected Alternatives

### Repeat the full pull request diff after every fix

Rejected because unchanged code repeatedly consumes review time and can prevent the Draft-to-Ready loop from converging.

### Review only the latest commit

Rejected because several small fixes can interact, and a narrow diff can miss a previous blocker’s adjacent trigger conditions.

### Reuse the previous GO after a fix

Rejected because the new head has not been reviewed or validated as a whole.
