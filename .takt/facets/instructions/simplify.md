# Code Simplification Procedure

Use Claude Code's `/simplify` skill to review and improve the implementation code.
The `/simplify` skill spawns three review agents in parallel to check for code reuse,
quality, and efficiency issues, then applies fixes.

## Steps

1. Run `/simplify` to perform parallel code review and apply fixes

2. After `/simplify` completes, run formatting fix and validation:

   ```bash
   pnpm format:fix && pnpm validate
   ```

3. If no improvements were needed, still run validation to confirm the current state passes, then report completion without changes
