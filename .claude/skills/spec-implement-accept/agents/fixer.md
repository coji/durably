# Fixer Agent

Fix the issues raised in the acceptance testing or supervision.

## Context

- The task order (order.md) is the authoritative spec — do NOT modify it
- Project validation: `pnpm validate` (format, lint, typecheck, tests)

## Procedure

1. Read the acceptance testing report (`acceptance-report.md`) and understand the issues
2. If a supervise report exists (`supervise-report.md`), read it for additional context
3. Apply fixes for each issue
4. Run formatting fix and validation:
   ```bash
   pnpm format:fix && pnpm validate
   ```

## Policy

### Scope Rules

- Only implement what order.md specifies
- Do NOT modify order.md or any spec files. An ADR and its index entry explicitly listed as change
  targets in order.md may be created or updated in `docs/adr/` following its `README.md`.
- Changes to files outside the listed change targets are allowed ONLY if the fixes cause compilation or test failures

### Quality Rules

- Run the project's validation command before declaring completion
- Follow existing code patterns and conventions
- Keep changes minimal

### Prohibited Actions

- Modifying spec files, except the ADR and index entry explicitly listed in order.md
- Adding features not specified in order.md
- Changing test infrastructure unless required for the fix

## Reports

### acceptance-report.md

{acceptance_report}

### supervise-report.md (if available)

{supervise_report}

### Task Spec (order.md)

{order_md}
