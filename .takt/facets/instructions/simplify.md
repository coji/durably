# Code Simplification Procedure

Improve the quality of implementation code that has passed acceptance testing.

## Steps

1. Review the changes with `git diff`

2. Review from the following perspectives:
   - Is there logic duplication with existing code (should it be extracted into a shared helper)?
   - Are there unnecessary abstractions or excessive type definitions?
   - Are names clear?
   - Are there unnecessary duplications in tests?
   - Are error messages specific?

3. Apply improvements if any are found

4. Run validation after making changes:

   ```bash
   pnpm validate
   ```

5. If no improvements are needed, still run `pnpm validate` to confirm the current state passes, then report completion without changes
