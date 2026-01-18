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

Verify package integrity for API changes and spec updates.

## 1. Implementation

- [ ] **@coji/durably** (`packages/durably/src/`)
- [ ] **@coji/durably-react** (`packages/durably-react/src/`)
  - [ ] Browser hooks (`hooks/`)
  - [ ] Client hooks (`client/`)
  - [ ] Shared utilities (`shared/`)
  - [ ] Type definitions (`types.ts`)

## 2. Version Update

- [ ] `packages/durably/package.json` - version
- [ ] `packages/durably-react/package.json` - version

## 3. Documentation

### Core

- [ ] `packages/durably/docs/llms.md` - LLM docs (bundled in npm)
- [ ] `docs/spec.md` - Core specification

### React

- [ ] `packages/durably-react/docs/llms.md` - LLM docs (bundled in npm)
- [ ] `docs/spec-react.md` - React specification
- [ ] `website/api/durably-react/index.md` - Overview
- [ ] `website/api/durably-react/browser.md` - Browser hooks
- [ ] `website/api/durably-react/client.md` - Client hooks
- [ ] `website/api/durably-react/types.md` - Type definitions

### Website

- [ ] `website/public/llms.txt` - Core + React llms.md concatenated (`pnpm --filter durably-website generate:llms`)

## 4. README

- [ ] `packages/durably/README.md`
- [ ] `packages/durably-react/README.md`

## 5. Examples

- [ ] `examples/browser-vite-react/` - Browser mode example
- [ ] `examples/browser-react-router-spa/` - Browser mode with React Router
- [ ] `examples/fullstack-react-router/` - Client mode (server-connected)
- [ ] `examples/server-node/` - Node.js server example

## 6. Tests

### Core (`packages/durably/tests/`)

- [ ] `node/` - Node.js tests
- [ ] `browser/` - Browser tests

### React (`packages/durably-react/tests/`)

- [ ] `types.test.ts` - Type tests

Verify new features/changes are covered by tests.

## 7. Changelog

- [ ] `CHANGELOG.md` - Add version section

## 8. Validation

```bash
pnpm format:fix  # Fix formatting first (Claude-written code often has format errors)
pnpm lint:fix    # Fix lint issues
pnpm --filter durably-website generate:llms  # Regenerate website/public/llms.txt
pnpm validate    # Run format, lint, typecheck, test
```

Check `git status` for uncommitted changes.

---

## Common Oversights

### Browser/Client Mode Consistency

When React hooks should provide the same API in both Browser and Client modes:

| File                  | Mode          |
| --------------------- | ------------- |
| `hooks/use-job.ts`    | Browser mode  |
| `client/use-job.ts`   | Client mode   |

Ensure consistency in:
- Interface definitions
- Return values
- Options

### Code Examples in Documentation

Verify code examples in docs match actual API:
- Return value properties
- Option parameters
- Type definitions

### Type Exports

Check if new types are exported in `index.ts` / `client.ts`.

### Examples Consistency

If examples use new API, verify no type errors or runtime errors:

```bash
pnpm typecheck  # Includes all examples
```

Key components to check:
- `dashboard.tsx` - useRuns, useRunActions
- `*-progress.tsx` - useJob return values (status booleans)
