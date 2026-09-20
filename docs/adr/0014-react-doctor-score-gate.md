# ADR-0014: Require React Doctor 100/100 for every React project

## Status

accepted

## Context

The React bindings and four React examples can regress independently. Existing lint, typecheck, and tests do not check the React-specific quality and accessibility rules reported by React Doctor. A score on only the repository root or only changed files could miss a project.

React Doctor's scored CLI mode uses its scoring service. Its `--no-telemetry` mode does not return a score, so a numeric score gate must allow the CLI's metadata request. The supply-chain check is separate from React code quality and depends on external vulnerability data; the repository already has a pnpm supply-chain policy.

## Decision

Pin React Doctor in the workspace and list the React bindings and four examples in `doctor.config.json`. Scan the full scope without cache. `pnpm doctor:check` requires a complete result, all configured projects, no diagnostics, and a score of exactly 100 for each project. Run it in local validation and GitHub Actions. Disable React Doctor's supply-chain scan for this code-quality gate.

Fix actionable findings. When a rule conflicts with an intentional state transition or incorrectly reports a missing cleanup, place a reasoned suppression on the specific line; do not disable the rule for a project or file. Reassess these exceptions when changing the affected code.

## Consequences

- Every React project must maintain 100/100 before CI passes.
- The scored check requires access to React Doctor's scoring service and sends the CLI metadata documented by the tool; file contents are not sent for scoring.
- Score changes in a future React Doctor release are controlled by the pinned version and can be reviewed in a dependency update.
- The supply-chain policy remains pnpm's responsibility, separate from this score.
