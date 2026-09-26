# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Durably project.

## What is an ADR?

An ADR captures a significant architectural decision along with its context, consequences, and rejected alternatives. ADRs are numbered sequentially and are immutable once accepted on `main` — superseded decisions are marked as such with a pointer to the replacement.

Start an ADR as `proposed` while exploring the decision. Before opening an implementation Draft PR, check whether the decision already has a `proposed` ADR on `main`. Create one if needed, then change both the ADR and its index entry to `accepted` on the implementation branch; merging that same PR publishes the accepted decision. A proposal-only PR, which does not implement the decision described in the ADR, must leave both as `proposed`.
If the decision is implemented across multiple PRs, accept the ADR in the PR that completes it.

## Format

Each ADR follows this structure:

```markdown
# ADR-NNNN: Title

## Status

proposed | accepted | superseded by ADR-NNNN

## Context

Why this decision was needed.

## Decision

What we decided.

## Consequences

What changes as a result.

## Rejected Alternatives

What we considered and why we didn't do it.
```

## Index

| ADR                                                           | Title                                         | Status   |
| ------------------------------------------------------------- | --------------------------------------------- | -------- |
| [0001](0001-lease-based-runtime.md)                           | Lease-based runtime model                     | Accepted |
| [0002](0002-development-toolchain.md)                         | Managed runtime and compiler compatibility    | accepted |
| [0003](0003-draft-pr-review-gate.md)                          | Draft pull request review gate                | accepted |
| [0004](0004-durable-step-attempts.md)                         | Durable step attempt records                  | accepted |
| [0005](0005-parallel-step-join.md)                            | Parallel named steps and durable join         | accepted |
| [0006](0006-adr-acceptance-in-implementation-pr.md)           | Accept ADRs in implementation pull requests   | accepted |
| [0007](0007-explicit-trailing-run-coalescing.md)              | Explicit trailing run coalescing              | accepted |
| [0008](0008-active-run-coalescing-and-scoped-job-tracking.md) | Active-run coalescing and scoped job tracking | accepted |
| [0009](0009-cumulative-delta-review-rounds.md)                | Cumulative delta review rounds                | accepted |
| [0010](0010-durable-external-waits.md)                        | Durable external waits                        | accepted |
| [0011](0011-durable-wait-deadlines.md)                        | Durable wait deadlines and lifecycle timing   | accepted |
| [0012](0012-run-authorized-http-waits.md)                     | Run-authorized HTTP durable waits             | accepted |
| [0013](0013-oxc-lint-and-format.md)                           | Oxlint and Oxfmt for linting and formatting   | accepted |
| [0014](0014-react-doctor-score-gate.md)                       | React Doctor 100/100 gate                     | accepted |
| [0015](0015-github-oidc-npm-release.md)                       | GitHub OIDC npm releases                      | accepted |
| [0016](0016-events-follow-state-writes.md)                    | Events follow state writes directly           | accepted |
| [0017](0017-local-agent-loop-pinned-checkout.md)              | local-agent-loop from a pinned checkout       | accepted |
| [0018](0018-local-agent-loop-adaptive-routing.md)             | local-agent-loop adaptive routing             | proposed |
| [0019](0019-local-agent-loop-stop-before-llm.md)              | local-agent-loop stops before any LLM call    | accepted |
| [0020](0020-local-agent-loop-rejected-invocations.md)         | local-agent-loop rejected invocations         | accepted |
| [0021](0021-local-agent-loop-squashed-delivery-branch.md)     | local-agent-loop squashed delivery branch     | accepted |
| [0022](0022-local-agent-loop-external-repair-runs.md)         | local-agent-loop repair runs from findings    | accepted |

## Prior Art

Earlier design documents (RFCs) that led to these decisions are preserved in git history under `docs/rfcs/` (removed in the commit that introduced this ADR directory).
