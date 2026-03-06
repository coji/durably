---
name: doc-check
description: Catch stale docs after API changes. Runs automated pattern detection, then walks through every file that could be out of sync. Prevents the "forgot to update docs" follow-up PRs that always happen after API changes. Use when making API changes, renaming, restructuring, or before any release.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm:*)
  - Bash(node:*)
  - Bash(git:*)
  - Bash(chmod:*)
  - Bash(./*)
---

# Doc Check

Catch documentation and example drift after API/type changes.
Most follow-up PRs after a release are "forgot to update docs" — this skill prevents that.

## Phase 1: Automated Detection (most important)

Run the stale pattern detection script first. It catches more than manual review.

```bash
.claude/skills/doc-check/scripts/find-stale.sh
```

**Fix every `[STALE]` hit.** Each result includes a "Why" explaining the issue.

For change-specific patterns (e.g., a rename you just did):

```bash
.claude/skills/doc-check/scripts/find-stale.sh 'oldMethodName\|oldImportPath'
```

## Phase 2: Understand the Change

```bash
git diff --name-only main
```

Know what changed before walking through docs.

## Phase 3: Walk Through Documentation

Check files in priority order. Only review files relevant to the change scope.

### Tier 1: Package docs (bundled in npm — AI agents read these)

Highest reach. If an API changed, these almost certainly need updating.

- [ ] `packages/durably/docs/llms.md`
- [ ] `packages/durably-react/docs/llms.md`

### Tier 2: READMEs

First thing users see on GitHub/npm. Stale quick-start code = bad first impression.

- [ ] `README.md` (root)
- [ ] `packages/durably/README.md`
- [ ] `packages/durably-react/README.md`

### Tier 3: AI agent config

Claude Code and other AI tools read these to generate code. Stale info = wrong code suggestions.

- [ ] `CLAUDE.md`
- [ ] `.claude/skills/doc-check/SKILL.md` (this file)
- [ ] `.claude/skills/release-check/SKILL.md`

### Tier 4: Website API Reference

Users look these up when coding. Stale examples cause confusion.

| File                                     | Why it needs checking                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| `website/api/index.md`                   | Cheat sheet — duplicates info from other pages, easy miss |
| `website/api/create-durably.md`          | Options, methods, types                                   |
| `website/api/define-job.md`              | trigger/triggerAndWait signatures                         |
| `website/api/step.md`                    | step.run, step.progress code examples                     |
| `website/api/events.md`                  | Event type fields — must update every block on additions  |
| `website/api/http-handler.md`            | Endpoints, auth middleware                                |
| `website/api/durably-react/index.md`     | Overview + Quick Examples for both modes                  |
| `website/api/durably-react/fullstack.md` | createDurably, useJob, useRuns, etc.                      |
| `website/api/durably-react/spa.md`       | DurablyProvider, useJob, useRuns, etc.                    |
| `website/api/durably-react/types.md`     | Type definitions — add new exports here                   |

### Tier 5: Guides

Code examples embedded in prose. API changes silently break copy-paste.

| File                              | Why it needs checking                 |
| --------------------------------- | ------------------------------------- |
| `website/guide/quick-start.md`    | First code users copy-paste           |
| `website/guide/concepts.md`       | Core concept explanations with code   |
| `website/guide/server-mode.md`    | Server mode tutorial                  |
| `website/guide/fullstack-mode.md` | Fullstack mode tutorial               |
| `website/guide/spa-mode.md`       | SPA mode tutorial                     |
| `website/guide/error-handling.md` | Error handling patterns               |
| `website/guide/auth.md`           | Auth & multi-tenant patterns          |
| `website/guide/deployment.md`     | Deployment guide with mode comparison |

### Tier 6: Sidebar config

Menu links and anchors must match actual headings. Mismatches cause 404s.

- [ ] `website/.vitepress/config.ts` — VitePress slugifies headings for anchors

### Tier 7: Example apps

Working code that uses the public API. `pnpm typecheck` catches breakage.

| Directory                         | Mode           |
| --------------------------------- | -------------- |
| `examples/server-node`            | Server mode    |
| `examples/spa-vite-react`         | SPA mode       |
| `examples/spa-react-router`       | SPA mode       |
| `examples/fullstack-react-router` | Fullstack mode |

## Phase 4: Regenerate

```bash
pnpm --filter durably-website generate:llms
```

`website/public/llms.txt` is generated from `packages/*/docs/llms.md`. Never edit directly.

## Phase 5: Validate

```bash
pnpm format:fix
pnpm validate
```

## Phase 6: Final Check

Run the script again to confirm nothing was missed:

```bash
.claude/skills/doc-check/scripts/find-stale.sh
```

## Preferred Patterns

Use these in docs and examples. API reference may document alternatives.

| Pattern            | Preferred                          | Avoid                            |
| ------------------ | ---------------------------------- | -------------------------------- |
| Job registration   | `createDurably({ jobs: {} })`      | `.register()` chain              |
| Initialization     | `await durably.init()`             | `migrate()` + `start()` separate |
| Fullstack client   | `createDurably<typeof server>({})` | raw `useJob({ api, jobName })`   |
| Cross-job hooks    | `durably.useRuns()`                | `useRuns({ api })`               |
| Import (fullstack) | `from '@coji/durably-react'`       |                                  |
| Import (SPA)       | `from '@coji/durably-react/spa'`   |                                  |

## Updating the Script

When you make a new rename or API change, add a `check_pattern` call to `scripts/find-stale.sh`.
This way it's automatically caught in future runs.
