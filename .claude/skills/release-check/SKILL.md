---
name: release-check
description: Pre-release integrity check. Catches stale docs, broken examples, missing exports, and version mismatches before publishing. Run before bumping versions or creating release PRs. Use for release check, version bump, pre-release, publish prep.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm:*)
  - Bash(git:*)
  - Bash(./*)
---

# Release Check

Pre-release integrity check. Doc drift after API changes is the #1 source of follow-up PRs.
This skill catches everything before it ships.

## Phase 1: Automated Detection

Run doc-check's stale pattern script first:

```bash
.claude/skills/doc-check/scripts/find-stale.sh
```

Fix every `[STALE]` hit before proceeding.

## Phase 2: Understand the Scope

```bash
git diff main --stat
git log --oneline main..HEAD
```

## Phase 3: Implementation

### Packages

- [ ] **@coji/durably** (`packages/durably/src/`)
- [ ] **@coji/durably-react** (`packages/durably-react/src/`)
  - [ ] SPA hooks (`hooks/`) — runs directly in browser
  - [ ] Fullstack hooks (`client/`) — connects to server via HTTP/SSE
  - [ ] Shared (`shared/`) — logic used by both modes
  - [ ] Types (`types.ts`) — public type definitions
  - [ ] Exports (`index.ts`, `spa.ts`) — are new types/hooks exported?

### Export completeness

New types/hooks must be exported or users can't import them.

- `packages/durably-react/src/index.ts` (fullstack)
- `packages/durably-react/src/spa.ts` (SPA)
- `packages/durably/src/index.ts` (core)

## Phase 4: Version

- [ ] `packages/durably/package.json`
- [ ] `packages/durably-react/package.json`

Check peer dependency ranges too.

## Phase 5: Documentation

Doc drift is the most common post-release issue. Check everything.

### Package docs (bundled in npm)

AI agents read these from `node_modules`. Stale info = wrong generated code.

- [ ] `packages/durably/docs/llms.md`
- [ ] `packages/durably-react/docs/llms.md`

### READMEs

- [ ] `README.md` (root)
- [ ] `packages/durably/README.md`
- [ ] `packages/durably-react/README.md`

### AI agent config

- [ ] `CLAUDE.md` — core concepts, defaults, design decisions
- [ ] `.claude/skills/doc-check/SKILL.md` — file paths, pattern tables
- [ ] `.claude/skills/release-check/SKILL.md` — this file

### Website API Reference

- [ ] `website/api/index.md` — cheat sheet (duplicates info, easy to miss)
- [ ] `website/api/create-durably.md`
- [ ] `website/api/define-job.md`
- [ ] `website/api/step.md`
- [ ] `website/api/events.md`
- [ ] `website/api/http-handler.md`
- [ ] `website/api/durably-react/index.md`
- [ ] `website/api/durably-react/fullstack.md`
- [ ] `website/api/durably-react/spa.md`
- [ ] `website/api/durably-react/types.md`

### Guides

Code examples embedded in prose. API changes silently break copy-paste.

- [ ] `website/guide/quick-start.md`
- [ ] `website/guide/concepts.md`
- [ ] `website/guide/server-mode.md`
- [ ] `website/guide/fullstack-mode.md`
- [ ] `website/guide/spa-mode.md`
- [ ] `website/guide/error-handling.md`
- [ ] `website/guide/auth.md`
- [ ] `website/guide/multi-tenant.md`
- [ ] `website/guide/deployment.md`

### Sidebar config

- [ ] `website/.vitepress/config.ts` — links, menu text, anchors

### Generated files

- [ ] `website/public/llms.txt` — regenerate: `pnpm --filter durably-website generate:llms`

## Phase 6: Examples

All examples must compile and use current API patterns.

- [ ] `examples/server-node/`
- [ ] `examples/spa-vite-react/`
- [ ] `examples/spa-react-router/`
- [ ] `examples/fullstack-react-router/`

Check for:

- `jobs: {}` option (not `.register()` chain)
- `await durably.init()` (not `migrate()` + `start()`)
- Current import paths

## Phase 7: Tests

- [ ] `packages/durably/tests/`
- [ ] `packages/durably-react/tests/`
  - [ ] `browser/` — SPA hook tests
  - [ ] `client/` — Fullstack hook tests

Verify new features/changes have test coverage.

## Phase 8: Changelog

- [ ] `CHANGELOG.md` — add version section

## Phase 9: Validate

```bash
pnpm format:fix
pnpm lint:fix
pnpm --filter durably-website generate:llms
pnpm validate
```

Check `git status` for uncommitted changes.

## Phase 10: Final Check

```bash
.claude/skills/doc-check/scripts/find-stale.sh
```

Must be clean before release.

---

## SPA/Fullstack Consistency

Hooks in both modes should have consistent interfaces, return values, and options:

| SPA                 | Fullstack            |
| ------------------- | -------------------- |
| `hooks/use-job.ts`  | `client/use-job.ts`  |
| `hooks/use-runs.ts` | `client/use-runs.ts` |

## Preferred Patterns

| Pattern            | Preferred                          | Avoid                            |
| ------------------ | ---------------------------------- | -------------------------------- |
| Job registration   | `createDurably({ jobs: {} })`      | `.register()` chain              |
| Initialization     | `await durably.init()`             | `migrate()` + `start()` separate |
| Fullstack client   | `createDurably<typeof server>({})` | raw `useJob({ api, jobName })`   |
| Cross-job hooks    | `durably.useRuns()`                | `useRuns({ api })`               |
| Import (fullstack) | `from '@coji/durably-react'`       |                                  |
| Import (SPA)       | `from '@coji/durably-react/spa'`   |                                  |
