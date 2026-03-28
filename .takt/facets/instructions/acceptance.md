# Acceptance Testing Procedure

Verify that the implementation meets the completion criteria of the task spec (order.md).

## Steps

1. List all completion criteria from order.md

2. For each completion criterion:
   - Read the relevant code and verify the implementation
   - Judge whether the criterion is met as Yes/No
   - If No, describe the specific deficiency

3. Run validation:

   ```bash
   pnpm validate
   ```

   Confirm that all checks (format, lint, typecheck, tests) pass

4. Scope check:
   - Get the list of changed files with `git diff --name-only`
   - Cross-reference with the files to change listed in order.md
   - Check for any out-of-scope changes (refer to prohibited actions in the policy)

5. Judgment:
   - All completion criteria Yes and validation passes -> approved
   - Otherwise -> needs_fix (include specific fix instructions)
