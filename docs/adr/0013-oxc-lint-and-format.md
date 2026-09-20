# ADR-0013: Use Oxlint and Oxfmt for repository linting and formatting

## Status

accepted

## Context

The workspace uses Biome for linting and Prettier with import-organizing and Tailwind plugins for formatting. Each library package and example repeats the tool dependencies and scripts. We want one fast lint and format toolchain without adopting the rest of Vite+ or changing the build and test tools.

Oxlint and Oxfmt do not interpret Biome and Prettier configuration identically. A migration must preserve the intentional formatting settings, import and Tailwind sorting, ignored generated files, and existing lint exceptions. Enabling every Oxlint category would also introduce many rules that were not part of the previous policy.

## Decision

Install standalone `oxlint` and `oxfmt` at the workspace root. Keep each package's `lint`, `lint:fix`, `format`, and `format:fix` scripts so the existing Turbo and CI tasks continue to work. Configure both tools at the root and remove the redundant per-package Biome and Prettier configurations and dependencies.

Oxfmt retains semicolon, quote, trailing-comma, and line-width settings. Enable its built-in import and Tailwind sorting and transfer `.prettierignore` patterns to `ignorePatterns`. Disable its default `package.json` key sorting, which was not part of the previous formatter setup.

Oxlint enables its correctness rules and the explicit TypeScript and unused-variable checks used here. Preserve the test-file exceptions, intentional `any` and non-null assertions, and the rest-destructuring pattern used to project public run data. Additional Oxlint categories can be adopted separately after reviewing their findings.

## Consequences

- Lint and format commands stay available through the existing package scripts, Turbo tasks, CI, and pre-commit hook.
- Import grouping and some line wrapping change where Oxfmt differs from Prettier. This migration includes that formatting-only diff.
- Tool versions are shared across the workspace; packages are developed through the monorepo's root installation.
- Oxlint's rule set is not a one-to-one translation of Biome's recommended rules. Future rule expansion needs a separate review.

## Rejected Alternatives

- Adopting Vite+ to obtain Oxlint and Oxfmt: it would also change the test, build, package-manager, and task-runner setup, outside this decision's scope.
- Enabling all Oxlint categories during migration: it would combine a tool change with unrelated code changes and broad new lint policy.
- Keeping Prettier only for its plugins: Oxfmt has built-in import and Tailwind sorting, so a second formatter is unnecessary for the current files.
