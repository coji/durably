---
name: factory
description: >-
  Hand a GitHub issue to the local Durably factory and get back a run id
  immediately, instead of holding this session open for the whole job. The
  factory implements, verifies against a pinned check, runs two independent
  reviews, and delivers a patch or a draft pull request. Use when the user
  says "#234 やりたい", "issue 234 をファクトリーに投げて", "factory 234",
  "run the factory on this issue", or asks for the status, report, or
  comparison of a factory run. For a job this session should do itself,
  start to finish, use spec-implement-accept instead.
allowed-tools:
  - Bash
  - Read
---

# Factory run

Dispatch work to the local factory worker and report back. The worker does
the job; this session only starts it and reads results.

`spec-implement-accept` does the same work inside this session. Prefer the
factory when the run should survive this terminal closing, when several
issues should progress at once, or when the per-stage time, token and cost
record matters. Prefer `spec-implement-accept` when the user wants to watch
and steer it.

## Input

- `#234`, `234`, or a GitHub issue URL — the issue to work.
- Free text — the task, when there is no issue.
- `status <runId>` / `report <runId>` / `compare <runId>,<runId>` — read an
  existing run instead of starting one.

## Starting a run

1. Confirm a worker is running:

   ```bash
   pgrep -f "local-agent-loop.*cli.ts worker" | wc -l
   ```

   Count the worker process itself, not the pnpm wrapper that launched it: a
   single healthy worker matches this pattern exactly once, however it was
   started.

   If the count is 0, tell the user to start one in another terminal and stop
   here. Do not start it yourself; it is long-running and owns the terminal.

   ```bash
   pnpm --filter example-local-agent-loop demo worker
   ```

   A second worker on the same state root refuses to start and prints the
   running one's pid and checkout, so a count above 1 means a worker from a
   version before that lock is still running. Say so and stop; the user
   stops the old one (`kill <pid>`). Which worker picks up a run no longer
   matters for its settings: the timeouts and the Codex CLI are fixed in the
   run when it is triggered, never read from the worker's environment.

2. Confirm the repository is clean. The factory cuts a worktree from a
   commit, so uncommitted work would not be included and the user should know
   that before it starts.

   ```bash
   git status --porcelain=v1
   ```

3. Trigger. From the repository root:

   ```bash
   pnpm --filter example-local-agent-loop demo trigger \
     --provider codex --repo "$(git rev-parse --show-toplevel)" \
     --issue 234 --check "pnpm validate" --setup "pnpm install --frozen-lockfile"
   ```

   - `--check` is the pinned grading command and is required. For this
     repository it is `pnpm validate`.
   - Never pass `--publish` unless the user explicitly asked for a pull
     request. Without it the run delivers a patch and touches nothing remote.
   - Use `--provider claude` when the user asks for Claude, `--provider fake`
     for a dry run of the wiring.

4. Report the run id and stop. Do not poll. The run takes as long as the work
   takes, and this session does not need to stay open.

## Reading a run

```bash
pnpm --filter example-local-agent-loop demo status   # runs needing attention and the next command for each
pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
pnpm --filter example-local-agent-loop demo compare --runs <runId>,<runId>
```

The report carries per-stage wall time, tokens including cache reads and
writes, and API-equivalent cost estimates. Relay the summary, the delivery
location, and the two review verdicts. Say plainly when a run failed
verification or hit the repair cap.

## Delivering

The run writes a patch under `~/.local/state/local-agent-loop/runs/<runId>/delivery/`;
`demo status` shows its path, branch, and commit.
Apply it only when the user asks:

```bash
git apply --check <patch>   # dry run first
```

The human decides whether to apply, open a pull request, or discard. Never
merge anything.
