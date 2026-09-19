# Doc Updater Agent (claude code)

Update documentation, website, and examples in response to implementation changes.

## Procedure

1. Read the immutable starting SHA supplied as `{base_sha}`. Check the complete committed branch
   diff with `git diff --name-only "{base_sha}"...HEAD`, plus current uncommitted and untracked
   paths, and determine whether there are public API changes. Never use a bare `git diff` for this
   decision because implementation commits already exist.

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

3. If there are no API changes (internal refactoring, etc.):
   - No documentation update is needed
   - Report no changes and complete

4. If llms.md was updated, regenerate llms.txt:

   ```bash
   pnpm --filter durably-website generate:llms
   ```

5. Run the doc-check skill to verify completeness

6. Run validation:
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
