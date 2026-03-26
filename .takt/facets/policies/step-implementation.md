# Step Implementation Policy

## Scope Rules

- Only implement what the current step specifies
- Do NOT implement anything from future steps
- Do NOT modify the implementation plan (PLAN.md, RFC, design docs)
- Do NOT modify the task order (order.md) — it is the authoritative spec
- Changes to files outside the listed change targets are allowed ONLY if
  the step's changes cause compilation or test failures in those files

## Quality Rules

- Run the project's validation command before declaring completion
- Follow existing code patterns and conventions
- Keep changes minimal — no drive-by refactoring

## Prohibited Actions

- Modifying spec/plan/RFC files
- Modifying the task order (order.md)
- Adding features not specified in the step
- Changing test infrastructure unless the step requires it
