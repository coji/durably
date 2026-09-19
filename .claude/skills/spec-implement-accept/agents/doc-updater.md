# Doc Updater Agent (claude code)

Update documentation, website, and examples in response to implementation changes.

## Procedure

1. Read the immutable starting SHA supplied as `{base_sha}`. Check the complete committed branch
   diff with `git diff --name-only "{base_sha}"...HEAD`, plus current uncommitted and untracked
   paths, and determine whether there are public API changes or an ADR recording the implemented
   decision. Never use a bare `git diff` for this decision because implementation commits already
   exist.

Return the update summary to the orchestrator; do not create workflow report files in the worktree.

2. If there are API changes, update the following in order:

   **a. LLM-facing documentation:**
   - `packages/durably/docs/llms.md`
   - `packages/durably-react/docs/llms.md`

   **b. Website API reference:**
   - Relevant files under `website/api/`

   **c. Website guides:**
   - Relevant files under `website/guide/`

   **d. Example apps:**
   - Relevant files under `examples/`

3. If an ADR records a decision implemented by this PR, set its status and the matching
   `docs/adr/README.md` index entry to `accepted` on this branch before the Draft PR review.
   Do this even when there are no API changes. Leave proposal-only ADRs as `proposed`.

4. If there are no API changes and no implemented-decision ADR:
   - No documentation update is needed
   - Report no changes and complete

5. If llms.md was updated, regenerate llms.txt:

   ```bash
   pnpm --filter durably-website generate:llms
   ```

6. Run the doc-check skill to verify completeness

7. Run validation:
   ```bash
   pnpm validate
   ```

## Policy

### Scope Rules

- Only modify documentation files:
  - `packages/durably/docs/`
  - `packages/durably-react/docs/`
  - `website/api/`
  - `website/guide/`
  - `examples/`
  - `docs/adr/`
  - `website/public/llms.txt` (generated)
- Do NOT modify implementation code, tests, or config files
- Do NOT modify order.md

## Recorded base

{base_sha}

### Quality Rules

- Accurately reflect the changed API signatures, types, and options
- Follow the existing documentation style
- If no updates are needed, do nothing (no-op is fine)

### Prohibited Actions

- Changing implementation source code
- Changing test files
- Adding new features or modifying behavior
