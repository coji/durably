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

After any API change, verify all documentation is in sync. This checklist is ordered by priority.

## How to Use

1. Identify what changed (new field, new method, changed signature, etc.)
2. Walk through each section below
3. Check only items relevant to the change scope (core, react, or both)
4. Mark items as done or N/A

## 1. Package LLM Docs (bundled in npm)

These are the primary references for AI coding agents.

- [ ] `packages/durably/docs/llms.md` — Core API docs
- [ ] `packages/durably-react/docs/llms.md` — React hooks docs

## 2. Website API Reference

### Core API

| File                            | Content                                                |
| ------------------------------- | ------------------------------------------------------ |
| `website/api/index.md`          | Quick reference / cheat sheet (covers ALL APIs)        |
| `website/api/create-durably.md` | `createDurably()`, instance methods, types             |
| `website/api/define-job.md`     | `defineJob()`, job config                              |
| `website/api/step.md`           | Step context (`step.run`, `step.progress`, `step.log`) |
| `website/api/events.md`         | Event types and their fields                           |
| `website/api/http-handler.md`   | `createDurablyHandler()`, request/response types       |

### React API

| File                                   | Content                                        |
| -------------------------------------- | ---------------------------------------------- |
| `website/api/durably-react/index.md`   | React hooks overview                           |
| `website/api/durably-react/browser.md` | Browser-mode hooks (`useJob`, `useRuns`, etc.) |
| `website/api/durably-react/client.md`  | Client-mode hooks (server-connected)           |
| `website/api/durably-react/types.md`   | Shared type definitions                        |

### Guides (check if examples use changed API)

| File                               | Content                   |
| ---------------------------------- | ------------------------- |
| `website/guide/concepts.md`        | Core concepts explanation |
| `website/guide/getting-started.md` | Getting started tutorial  |
| `website/guide/csv-import.md`      | CSV import example        |
| `website/guide/background-sync.md` | Background sync example   |
| `website/guide/offline-app.md`     | Offline app example       |

### Example Apps

Grep for the changed symbol name in `examples/` to find usage. Each example demonstrates a different deployment pattern:

| Directory                           | Pattern                        | Key files                                                           |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `examples/server-node`              | Node.js server (core API only) | `jobs/*.ts`, `lib/durably.ts`, `basic.ts`                           |
| `examples/browser-vite-react`       | Browser SPA (Vite + React)     | `src/jobs/*.ts`, `src/lib/durably.ts`, `src/components/*.tsx`       |
| `examples/browser-react-router-spa` | Browser SPA (React Router)     | `app/jobs/*.ts`, `app/lib/durably.ts`, `app/routes/**/*.tsx`        |
| `examples/fullstack-react-router`   | Fullstack (React Router + SSE) | `app/jobs/*.ts`, `app/lib/durably.server.ts`, `app/routes/**/*.tsx` |

## 3. Generated Files

These are derived from package docs and must be regenerated:

```bash
pnpm --filter durably-website generate:llms
```

- [ ] `website/public/llms.txt` — Concatenation of core + react `llms.md`

## 4. Scope Guide

Use this table to quickly determine which docs to check based on what changed:

| Change Type                      | Docs to Check                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| New field on `Run` / `RunFilter` | llms.md (core), create-durably.md, index.md, http-handler.md, react browser.md + client.md            |
| New event field                  | llms.md (core), events.md, index.md                                                                   |
| New step method                  | llms.md (core), step.md, index.md                                                                     |
| New trigger option               | llms.md (core), index.md, http-handler.md, create-durably.md                                          |
| React hook change                | llms.md (react), browser.md, client.md, index.md (react section)                                      |
| HTTP handler change              | llms.md (core), http-handler.md, client.md                                                            |
| New config option                | llms.md (core), create-durably.md, index.md                                                           |
| Job/step API change              | All example apps (`examples/`)                                                                        |
| Event type change                | `examples/fullstack-react-router` (SSE), `examples/browser-*` (direct events)                         |
| React hook change                | `examples/browser-vite-react`, `examples/browser-react-router-spa`, `examples/fullstack-react-router` |

## 5. Common Oversights

- **`website/api/index.md`** is a cheat sheet — it duplicates key info from other pages and is easy to forget
- **Event field additions** must be added to every event type comment block in `events.md`
- **Browser and Client mode** hooks often have parallel options tables — update both
- **Type definitions** in `website/api/durably-react/types.md` may need new type exports
- **`website/public/llms.txt`** is generated — don't edit directly, regenerate instead
- **Code examples** in guides may use the changed API — grep for the symbol name in `website/guide/`
- **Example apps** in `examples/` are working apps that use the public API — grep for the changed symbol in all 4 examples

## 6. Verification

```bash
pnpm format:fix
pnpm --filter durably-website generate:llms
pnpm validate
```
