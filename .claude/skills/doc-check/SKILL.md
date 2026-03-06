---
name: doc-check
description: Documentation update checklist. Run after API changes to find documentation that needs updating. Use for doc check, documentation review, docs update, API change docs.
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(pnpm:*)
  - Bash(node:*)
  - Bash(git:*)
---

# Documentation Update Checklist

After any API change, verify ALL documentation is in sync.

## Step 1: Identify What Changed

Run `git diff --name-only main` (or check the current branch's changes) to understand the scope.

## Step 2: Grep for Old Patterns

This is the most important step. Run grep across the ENTIRE repo for old API patterns that need updating:

```bash
# Example patterns to search for (adapt to the specific change):
grep -rn 'oldMethodName\|oldImportPath\|oldOptionName' \
  --include='*.md' --include='*.ts' --include='*.tsx' \
  packages/ website/ examples/ README.md CLAUDE.md .claude/
```

**Every hit must be reviewed.** This catches documentation, examples, skills, and config files.

Common patterns to check:

- Old method/function names
- Old import paths (`@coji/durably-react/client` → `@coji/durably-react`)
- Old API patterns (`.register()` chain vs `jobs:` option)
- Old file paths in examples (`durably.hooks.ts` → `durably.ts`)
- Old directory names (`browser-*` → `spa-*`)

## Step 3: Check All Documentation Files

### Tier 1: Package Docs (bundled in npm — highest priority)

- [ ] `packages/durably/docs/llms.md`
- [ ] `packages/durably-react/docs/llms.md`

### Tier 2: README files

- [ ] `README.md` (root)
- [ ] `packages/durably/README.md`
- [ ] `packages/durably-react/README.md`

### Tier 3: Agent/AI config

- [ ] `CLAUDE.md`
- [ ] `.claude/skills/doc-check/SKILL.md` (this file — update tables if files change)
- [ ] `.claude/skills/release-check/SKILL.md`

### Tier 4: Website API Reference

| File                                     | Content                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `website/api/index.md`                   | Quick reference / cheat sheet (covers ALL APIs)  |
| `website/api/create-durably.md`          | `createDurably()`, instance methods, types       |
| `website/api/define-job.md`              | `defineJob()`, job config, trigger methods       |
| `website/api/step.md`                    | Step context (`step.run`, `step.progress`, etc.) |
| `website/api/events.md`                  | Event types and their fields                     |
| `website/api/http-handler.md`            | `createDurablyHandler()`, auth middleware        |
| `website/api/durably-react/index.md`     | React hooks overview + quick examples            |
| `website/api/durably-react/fullstack.md` | Fullstack hooks (server-connected)               |
| `website/api/durably-react/spa.md`       | SPA hooks (`useJob`, `useRuns`, etc.)            |
| `website/api/durably-react/types.md`     | Shared type definitions                          |

### Tier 5: Website Guides

| File                               | Content                  |
| ---------------------------------- | ------------------------ |
| `website/guide/concepts.md`        | Core concepts            |
| `website/guide/getting-started.md` | Getting started tutorial |
| `website/guide/csv-import.md`      | CSV import example       |
| `website/guide/background-sync.md` | Background sync example  |
| `website/guide/offline-app.md`     | Offline app example      |

### Tier 6: Website Config

- [ ] `website/.vitepress/config.ts` — Sidebar links, menu text, anchor targets

### Tier 7: Example Apps

Grep for the changed symbol in all examples:

| Directory                         | Pattern        | Key files                                                           |
| --------------------------------- | -------------- | ------------------------------------------------------------------- |
| `examples/server-node`            | Server mode    | `jobs/*.ts`, `lib/durably.ts`, `basic.ts`                           |
| `examples/spa-vite-react`         | SPA mode       | `src/jobs/*.ts`, `src/lib/durably.ts`, `src/components/*.tsx`       |
| `examples/spa-react-router`       | SPA mode       | `app/jobs/*.ts`, `app/lib/durably.ts`, `app/routes/**/*.tsx`        |
| `examples/fullstack-react-router` | Fullstack mode | `app/jobs/*.ts`, `app/lib/durably.server.ts`, `app/routes/**/*.tsx` |

## Step 4: Regenerate & Validate

```bash
pnpm format:fix
pnpm --filter durably-website generate:llms   # Regenerate website/public/llms.txt
pnpm validate                                  # format, lint, typecheck, test
```

## Step 5: Final Grep

Run the same grep from Step 2 again to confirm nothing was missed.

## Scope Guide

Quick lookup for which docs to check based on change type:

| Change Type         | Docs to Check                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------- |
| New field on `Run`  | llms.md (core), create-durably.md, index.md, http-handler.md, react fullstack.md + spa.md |
| New event field     | llms.md (core), events.md, index.md                                                       |
| New step method     | llms.md (core), step.md, index.md                                                         |
| New trigger option  | llms.md (core), index.md, http-handler.md, create-durably.md                              |
| React hook change   | llms.md (react), fullstack.md, spa.md, react index.md                                     |
| HTTP handler change | llms.md (core), http-handler.md, fullstack.md                                             |
| New config option   | llms.md (core), create-durably.md, index.md, CLAUDE.md                                    |
| Import path change  | ALL files (grep is the only reliable way)                                                 |
| API naming change   | ALL files (grep is the only reliable way)                                                 |
| Example dir rename  | skills, doc-check, release-check, website config                                          |
| Sidebar structure   | `website/.vitepress/config.ts`                                                            |

## Common Oversights

- **`website/api/index.md`** is a cheat sheet — duplicates key info, easy to forget
- **`CLAUDE.md`** describes core concepts — update when APIs change
- **Skills files** reference file paths and patterns — update when structure changes
- **Sidebar anchors** must match actual heading text (VitePress slugifies headings)
- **`website/public/llms.txt`** is generated — never edit directly, always regenerate
- **`init()` is the recommended method** — don't use `migrate()` + `start()` in examples
- **`jobs: {}` option is preferred** over `.register()` chain in examples and guides
