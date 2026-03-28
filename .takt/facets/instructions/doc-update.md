# Documentation Update Procedure

Update documentation, website, and examples in response to implementation changes.

## Steps

1. Check changed files with `git diff --name-only` and determine whether there are API changes

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

5. Run validation:

   ```bash
   pnpm validate
   ```

## Rules

- Accurately reflect the changed API signatures, types, and options
- Do not modify implementation code (documentation files only)
- Follow the existing documentation style
- If no updates are needed, do nothing (no-op is fine)
