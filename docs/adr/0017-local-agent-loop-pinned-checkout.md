# ADR-0017: Use local-agent-loop from a pinned checkout with a fixed state root

## Status

accepted

## Context

`examples/local-agent-loop` started as a demo that worked on its bundled sample. Issue #222 makes it usable on other repositories: a `factory.json` and a task file are all a target repository has to hold. That raises two questions the example never had to answer. Where does the code run from, and where do the database and each run's worktree, checkpoints and patch live?

Before this change the database sat in the checkout (`examples/local-agent-loop/local-agent-loop.db`, or wherever `DURABLY_DB` pointed) and run data under the checkout's `runs/`. With the worker and the CLI started from different directories or checkouts, two processes could open different databases, and runs silently disappeared from `status` and `approve`.

## Decision

- Another repository uses the factory by running `demo worker` and `demo trigger --repo <path>` from a durably checkout pinned to a commit the user records. The target repository holds only `factory.json` and input files.
- The database and all run data live in one fixed directory, `~/.local/state/local-agent-loop/`, outside both the checkout and the target repository. No flag or environment variable moves it; `DURABLY_DB` is ignored. Only tests pass another root, through a code-level option.
- The old in-checkout database is not migrated. When it still exists, the worker and CLI print one warning naming it and the new location, and the README says how to finish or discard its runs first.

## Consequences

- Every command finds the same runs without arguments, and switching the checkout to another commit keeps past runs readable.
- One user account has one factory database. Running two independent factories side by side needs a second account or a code change.
- Upgrading from the old layout loses access to runs still open in the old database unless they are finished with the old version first.

## Rejected Alternatives

### Copy the code into each target repository

Rejected as the way to use it. Each copy drifts from fixes made here, and the target repository would carry the factory's dependencies. `docs/porting.md` still describes copying for a user who needs their own `Target` or wiring.

### Let `DURABLY_DB` or a `--state-dir` flag move the state

Rejected because it brings back the failure it was meant to fix: a worker and a CLI started with different settings look at different databases, and runs vanish without an error.

### Split the factory into a published package now

Deferred. The engine and policy interfaces are still changing with each real run, and a package would freeze them early. Revisit when a second repository needs its own `Target`, when the pinned-checkout workflow's upgrade steps become a burden, or when the engine interfaces have stayed unchanged across several releases.
