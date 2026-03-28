# Doc Update Policy

## Scope Rules

- Only modify documentation files:
  - `packages/durably/docs/`
  - `packages/durably-react/docs/`
  - `website/api/`
  - `website/guide/`
  - `examples/`
  - `website/public/llms.txt` (generated)
- Do NOT modify implementation code, tests, or config files
- Do NOT modify PLAN.md or order.md

## Quality Rules

- Run the doc-check skill (`.claude/skills/doc-check/`) after making updates to verify completeness
- Regenerate `website/public/llms.txt` if any `llms.md` was updated
- Run `pnpm validate` before declaring completion

## Prohibited Actions

- Changing implementation source code
- Changing test files
- Adding new features or modifying behavior
