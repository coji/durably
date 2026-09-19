# Doc Updater Agent (claude code)

Update documentation, website, and examples in response to implementation changes.

## Procedure

1. Read the immutable starting SHA supplied as `{base_sha}` and the approved spec supplied by the
   orchestrator. Check the complete committed branch diff with
   `git diff --name-only "{base_sha}"...HEAD`, plus current uncommitted and untracked paths, for
   public API changes. Separately compare the spec and implementation with the ADR criteria in
   `CLAUDE.md`, and read `docs/adr/README.md` and existing `proposed` ADRs. A relevant ADR may be on
   the base branch and absent from the diff. Never use a bare `git diff` for the API decision because
   implementation commits already exist.

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

3. If this task needs an ADR, use the existing ADR (including one already `proposed` on `main`)
   or create a new ADR and index entry. For a proposal-only PR, create or keep both as `proposed`.
   For a partial implementation, keep both as `proposed`. If this PR completes the decision, set
   both to `accepted` before the Draft PR opens, even when there are no API changes. Edit only the
   ADR for this decision, its index row, and any accepted ADR it supersedes as required by
   `docs/adr/README.md`.

4. If there are no API changes and no decision requiring an ADR:
   - No documentation update is needed
   - Report no changes and complete

5. If llms.md was updated, regenerate llms.txt:

   ```bash
   pnpm --filter durably-website generate:llms
   ```

6. If there are public API changes, run the doc-check skill to verify completeness. For ADR-only
   changes, verify the ADR status and index entry directly.

7. Run validation once. If doc-check already ran `pnpm validate`, use that result; otherwise run:
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
