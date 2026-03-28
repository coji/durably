# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Durably project.

## What is an ADR?

An ADR captures a significant architectural decision along with its context, consequences, and rejected alternatives. ADRs are numbered sequentially and are immutable once accepted — superseded decisions are marked as such with a pointer to the replacement.

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

| ADR                                 | Title                     | Status   |
| ----------------------------------- | ------------------------- | -------- |
| [0001](0001-lease-based-runtime.md) | Lease-based runtime model | Accepted |

## Prior Art

Earlier design documents (RFCs) that led to these decisions are preserved in git history under `docs/rfcs/` (removed in the commit that introduced this ADR directory).
