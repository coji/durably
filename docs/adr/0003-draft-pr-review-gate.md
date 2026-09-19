# ADR-0003: Draft pull request review gate

## Status

accepted

## Context

The implementation workflow needs a visible pull request before final code review so CI and preview checks can run against the same commit reviewers inspect. Marking a pull request Ready before issue acceptance, independent review, and exact-head checks complete creates a misleading review state. Reusing a prior review after a fix has the same problem because the reviewed target no longer exists at the pull request head.

The repository previously used takt definitions for multi-stage automation. This workflow must operate without takt: Claude Code orchestrates the end-to-end implementation skill, while Codex supplies the repository review skill. The eight-perspective review procedure also requires immutable targets, independent discovery, separate candidate verification, and an auditable GO or NO-GO result.

## Decision

Create the pull request as Draft after implementation, acceptance, simplification, supervision, and documentation complete. Store task specifications and review artifacts under the Git directory so they cannot enter the product diff.

Run two independent read-only review tracks against a fixed pushed commit: eight Codex perspectives using `gpt-5.6-sol` at medium reasoning effort, and a Claude Opus pass at high effort. The outer orchestrator creates snapshots, runs validation, dispatches both tracks without sharing their candidates, consolidates candidates, and assigns each candidate to a verifier other than its discoverer.

Treat unmet issue acceptance criteria, validated correctness blockers, incomplete review coverage, failed or pending checks, and head changes as blockers. After a fix, commit and push it, discard the prior decision, and review the new head. Repeated blockers or unavailable requirements leave the pull request Draft instead of forcing approval.

Mark the pull request Ready only when the combined report is GO, validation evidence names the current head, reported checks have completed without failure, and head checks immediately before and after the Ready mutation still match the reviewed SHA.

## Consequences

- Reviewers and CI operate on the same visible pull request commit.
- A fix always incurs a new complete review round; this increases review cost but prevents stale approvals.
- Workflow metadata remains local to the Git directory and is not merged with product code.
- Documentation-only changes can use exact-head local validation when GitHub reports no checks.
- The workflow stops safely as Draft when it cannot converge or a required reviewer or environment is unavailable.
- The workflow no longer depends on takt configuration or state.

## Alternatives considered

### Review before opening a pull request

Rejected because GitHub checks and previews would not run against the reviewed pull request head, and review progress would not be visible as Draft state.

### Continue using takt

Rejected because this repository wants the flow expressed as repository skills and policy that Codex and Claude Code can invoke directly.

### Mark Ready and fix findings afterward

Rejected because Ready would claim reviewability while known blockers or incomplete checks remain.

### Reuse GO after a fix

Rejected because any pushed fix changes the reviewed target and can introduce new cross-file behavior.
