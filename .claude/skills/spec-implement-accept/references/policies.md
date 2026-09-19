# Policies

Scope constraints and prohibited actions shared across workflow phases.

## Step Implementation Policy

Applied to: implement, acceptance, fix, supervise phases.

### Scope Rules

- Only implement what the current task specifies
- Do NOT modify the task order (order.md) — it is the authoritative spec
- Do NOT modify PLAN.md, RFC, or design docs
- Changes to files outside the listed change targets are allowed ONLY if
  the changes cause compilation or test failures in those files

### Quality Rules

- Run the project's validation command (`pnpm validate`) before declaring completion
- Follow existing code patterns and conventions
- Keep changes minimal — no drive-by refactoring

### Prohibited Actions

- Modifying spec/plan/RFC files
- Modifying the task order (order.md)
- Adding features not specified in the task
- Changing test infrastructure unless the task requires it

## Spec Revision Policy

Applied to: spec-revise phase.

### Scope Rules

- Only modify order.md
- Do not change implementation code, tests, or config files

### Revision Rules

- Always address blocking issues
- Suggestion issues may be accepted or rejected at discretion (state the reason)
- Maintain the spec structure (sections, completion criteria format)
- When adding or removing files to change, read the existing code to confirm the rationale

### Prohibited Actions

- Changing implementation code
- Ignoring review issues and reporting no changes
- Significantly expanding the scope (consider splitting instead)

## Doc Update Policy

Applied to: doc-update phase.

### Scope Rules

- Only modify documentation files:
  - `packages/durably/docs/`
  - `packages/durably-react/docs/`
  - `website/api/`
  - `website/guide/`
  - `examples/`
  - `website/public/llms.txt` (generated)
- Do NOT modify implementation code, tests, or config files
- Do NOT modify order.md

### Quality Rules

- Regenerate `website/public/llms.txt` if any `llms.md` was updated
- Run `pnpm validate` before declaring completion

### Prohibited Actions

- Changing implementation source code
- Changing test files
- Adding new features or modifying behavior

## Draft PR Review Policy

Applied after documentation update and before Ready state.

- Follow `docs/workflow/code-review.md` and the repository `$code-review` skill.
- Reviewers are read-only. Only the orchestrator applies fixes and updates the Draft PR.
- Every pushed fix creates a new review target and requires a complete new round.
- Do not mark Ready while a blocker, incomplete review, pending/failing check, or SHA mismatch remains.
- Repeated blockers stop the workflow with the PR still Draft; they are never waived automatically.
