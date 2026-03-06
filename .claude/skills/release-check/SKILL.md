---
name: release-check
description: Pre-release integrity check. Catches stale docs, broken examples, missing exports, and version mismatches before publishing. Run before bumping versions or creating release PRs. Use for release check, version bump, pre-release, publish prep.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm:*)
  - Bash(git:*)
  - Bash(gh:*)
  - Bash(grep:*)
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

Compare against the **last release tag**, not `main`:

```bash
# Find latest release tag
gh release list --limit 1
git log --oneline v0.10.0..HEAD   # replace with actual tag

# What changed since last release
git diff v0.10.0 --stat
```

Classify each PR/commit:

- **feat** (new feature) → minor bump
- **fix** (bug fix) → patch bump
- **feat** with breaking changes → minor bump (pre-1.0)
- **docs/chore** only → no version bump needed

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

### Determine version

Both packages share the same version. Use semver:

```bash
grep '"version"' packages/durably/package.json packages/durably-react/package.json
```

- **Patch** (0.10.x): bug fixes only
- **Minor** (0.x.0): new features, non-breaking changes, or breaking changes pre-1.0
- **Major** (x.0.0): breaking changes post-1.0

### Check peer dependencies

```bash
grep -A2 '"peerDependencies"' packages/durably-react/package.json
```

Ensure `@coji/durably` peer dep range covers the new version.

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

## Phase 8: Changelog & Release Notes

### CHANGELOG.md

Write a changelog entry in the repo root. Group by package and category:

```markdown
# Changelog

## v0.X.0

### @coji/durably

#### Added

- Feature description (#PR)

#### Changed

- Breaking change description (#PR)

### @coji/durably-react

#### Added

- Feature description (#PR)

#### Changed

- Breaking change description (#PR)
```

Conventions:

- One entry per user-facing change (not per commit)
- Include PR number for traceability
- Mark breaking changes clearly: **Breaking:**
- `docs:` and `chore:` commits don't need changelog entries

### Check previous releases

```bash
gh release list --limit 5
gh release view <tag>
```

Compare with the new changelog to make sure nothing is missing.

## Phase 9: Validate

```bash
pnpm format:fix
pnpm lint:fix
pnpm --filter durably-website generate:llms
pnpm validate
```

Check `git status` for uncommitted changes.

## Phase 10: Version Bump

Bump version in both packages (must stay in sync):

- `packages/durably/package.json`
- `packages/durably-react/package.json`

Commit as: `chore: bump version to 0.X.0`

## Phase 11: Final Check

```bash
.claude/skills/doc-check/scripts/find-stale.sh
```

Must be clean before release. After this, the release PR is ready to merge.

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
