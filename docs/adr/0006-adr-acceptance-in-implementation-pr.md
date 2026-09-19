# ADR-0006: Accept ADRs in implementation pull requests

## Status

accepted

## Context

The parallel step join required one PR for implementation and a second PR solely to change ADR-0005 from `proposed` to `accepted`. Repeating that for each issue makes the review and merge process unnecessarily costly. The accepted ADR is not published to `main` until its PR merges, so the status can be finalized on the implementation branch before that merge.

Some decisions have a proposal-only PR before implementation, and significant internal changes may need an ADR without changing a public API. A change-path-only documentation check can miss both cases.

## Decision

Keep an ADR `proposed` while its decision is being explored. Before opening the implementation Draft PR, compare the approved spec and implementation with the ADR criteria and existing proposed ADRs. Create or update the relevant ADR and index on the same branch, set both to `accepted` when the decision is fully implemented, and link the ADR from the PR. A proposal-only PR leaves its ADR `proposed`. When implementation spans multiple PRs, accept the ADR in the PR that completes the decision.

The Draft-to-Ready review checks ADR presence and status even when the ADR file was not originally in the implementation diff. If a review fix changes the decision, update the ADR on that branch before reviewing the new head. Merging the implementation PR publishes the accepted decision to `main`.

## Consequences

- A completed decision needs one implementation PR and one merge, without a status-only follow-up PR.
- A feature branch may contain an `accepted` ADR before merge; accepted ADRs become immutable once they are on `main`.
- The documentation phase must inspect the task and existing ADRs, not just the changed paths.
- A review fix that changes the decision also changes the corresponding ADR and invalidates the previous review result.

## Rejected Alternatives

### Change the ADR status after merging the implementation PR

Rejected because the main branch cannot be updated without another PR, creating repeated status-only reviews and merges.

### Always accept a proposal-only ADR

Rejected because it would describe an unimplemented decision as accepted.

### Check only ADR paths changed in the implementation PR

Rejected because an earlier proposal-only PR may already have added the relevant ADR to `main`, and a new internal decision may not yet have an ADR file.
