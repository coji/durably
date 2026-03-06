---
name: release-check
description: Pre-release integrity check. Verify package consistency for API changes and spec updates. Use for release check, version update, documentation consistency, pre-release verification.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm:*)
  - Bash(git:*)
---

# Release Check

Pre-release integrity check. Run through each section in order.

## 1. Diff Review

```bash
git diff main --stat
git diff main --name-only
```

Understand the full scope of changes before checking anything.

## 2. Grep for Stale Patterns

Search the entire repo for patterns that should have been updated but might have been missed:

```bash
# Adapt patterns to the specific release:
grep -rn 'OLD_PATTERN\|OLD_NAME\|OLD_PATH' \
  --include='*.md' --include='*.ts' --include='*.tsx' \
  packages/ website/ examples/ README.md CLAUDE.md .claude/
```

Every hit must be reviewed and fixed or confirmed intentional.

## 3. Implementation

- [ ] **@coji/durably** (`packages/durably/src/`)
- [ ] **@coji/durably-react** (`packages/durably-react/src/`)
  - [ ] SPA hooks (`hooks/`)
  - [ ] Fullstack hooks (`client/`)
  - [ ] Shared utilities (`shared/`)
  - [ ] Type definitions (`types.ts`)
  - [ ] Exports (`index.ts`, `spa.ts`)

## 4. Version Update

- [ ] `packages/durably/package.json` — version
- [ ] `packages/durably-react/package.json` — version

## 5. Documentation

### Package Docs (bundled in npm)

- [ ] `packages/durably/docs/llms.md`
- [ ] `packages/durably-react/docs/llms.md`

### README

- [ ] `README.md` (root)
- [ ] `packages/durably/README.md`
- [ ] `packages/durably-react/README.md`

### Agent/AI Config

- [ ] `CLAUDE.md`
- [ ] `.claude/skills/doc-check/SKILL.md`
- [ ] `.claude/skills/release-check/SKILL.md`

### Website API Reference

- [ ] `website/api/index.md` — Quick reference (covers ALL APIs)
- [ ] `website/api/create-durably.md` — Instance, options, methods
- [ ] `website/api/define-job.md` — Job definition, trigger methods
- [ ] `website/api/step.md` — Step context
- [ ] `website/api/events.md` — Event types
- [ ] `website/api/http-handler.md` — HTTP handler, auth middleware
- [ ] `website/api/durably-react/index.md` — React overview
- [ ] `website/api/durably-react/fullstack.md` — Fullstack hooks
- [ ] `website/api/durably-react/spa.md` — SPA hooks
- [ ] `website/api/durably-react/types.md` — Type definitions

### Website Guides

- [ ] `website/guide/concepts.md`
- [ ] `website/guide/getting-started.md`
- [ ] `website/guide/csv-import.md`
- [ ] `website/guide/background-sync.md`
- [ ] `website/guide/offline-app.md`

### Website Config

- [ ] `website/.vitepress/config.ts` — Sidebar links, menu text, anchors

### Generated Files

- [ ] `website/public/llms.txt` — Regenerate: `pnpm --filter durably-website generate:llms`

## 6. Examples

All examples must compile and use current API patterns:

- [ ] `examples/server-node/`
- [ ] `examples/spa-vite-react/`
- [ ] `examples/spa-react-router/`
- [ ] `examples/fullstack-react-router/`

Check for:

- Old import paths
- Old API patterns (`.register()` chain → `jobs:` option)
- Old file names
- `init()` usage (not `migrate()` + `start()`)

## 7. Tests

- [ ] `packages/durably/tests/` — Core tests
- [ ] `packages/durably-react/tests/` — React tests
  - [ ] `browser/` — SPA hook tests
  - [ ] `client/` — Fullstack hook tests

Verify new features/changes are covered by tests.

## 8. Changelog

- [ ] `CHANGELOG.md` — Add version section with summary of changes

## 9. Validation

```bash
pnpm format:fix
pnpm lint:fix
pnpm --filter durably-website generate:llms
pnpm validate    # format, lint, typecheck, test
```

Check `git status` for uncommitted changes after validation.

## 10. Final Grep

Re-run the grep from Step 2 to confirm all stale patterns are gone.

---

## Common Oversights

### Files People Forget

- `README.md` (root) — often has quick-start code examples
- `CLAUDE.md` — describes core concepts, referenced by AI agents
- `.claude/skills/*.md` — reference file paths, directory names, API patterns
- `website/.vitepress/config.ts` — sidebar links must match actual headings
- `website/api/index.md` — cheat sheet that duplicates info from other pages

### API Pattern Consistency

Preferred patterns in all docs and examples:

| Pattern            | Preferred                          | Avoid                              |
| ------------------ | ---------------------------------- | ---------------------------------- |
| Job registration   | `createDurably({ jobs: {} })`      | `.register()` chain                |
| Initialization     | `await durably.init()`             | `migrate()` + `start()` separately |
| Fullstack client   | `createDurably<typeof server>({})` | Raw `useJob({ api, jobName })`     |
| Cross-job hooks    | `durably.useRuns()`                | `useRuns({ api })`                 |
| Import (fullstack) | `from '@coji/durably-react'`       | N/A                                |
| Import (SPA)       | `from '@coji/durably-react/spa'`   | N/A                                |

### SPA/Fullstack Mode Consistency

When hooks exist in both modes, ensure consistent:

- Interface definitions
- Return values
- Options

| SPA                 | Fullstack            |
| ------------------- | -------------------- |
| `hooks/use-job.ts`  | `client/use-job.ts`  |
| `hooks/use-runs.ts` | `client/use-runs.ts` |

### Type Exports

Check new types are exported from:

- `src/index.ts` (fullstack)
- `src/spa.ts` (SPA)
