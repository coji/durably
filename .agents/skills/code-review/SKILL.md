---
name: code-review
description: Review a branch, pull request, or uncommitted diff from eight independent Codex perspectives and return evidence-backed candidates for cross-model verification. Use for `$code-review high`, pre-Ready review, and blocker re-review.
---

# Code review

The supported invocation is `$code-review high [base-ref-or-PR]`. `high` describes review coverage, not model reasoning effort. Read [the repository review policy](../../../docs/workflow/code-review.md) before starting. The policy defines blockers, reviewer models, the Ready gate, and convergence limits.

Reviewers are read-only. They do not edit, commit, push, comment on a PR, or change its Draft state. The orchestrator owns fixes and external mutations. A fix invalidates the preceding GO/NO-GO decision and starts a new round against the new head commit.

## 1. Freeze the target

Honor an explicit PR, base, ref, path, or `--uncommitted` scope. Otherwise compare the current branch with the merge-base of the remote default branch; never use the current branch's upstream as the default base.

Require the invoking orchestrator to provide and record:

- repository path, base name and SHA, target head SHA, changed paths, and task or issue acceptance criteria;
- `git status --porcelain=v1 -z`, committed/cached/worktree binary diffs, untracked paths, and hashes for included untracked files;
- a fixed snapshot outside the worktree, including symlinks and binary files, plus its hashes;
- applicable `AGENTS.md`, `CLAUDE.md`, and path-scoped rules.

Verify those inputs read-only before review. Do not create snapshots, launch the independent model track, run write-producing validation, checkout, reset, stash, or otherwise change the worktree. The outer orchestrator owns those actions and captures this track's final response. A PR review excludes unrelated local changes. If the fixed target cannot be read or verified, return `INCOMPLETE`.

## 2. Explore eight perspectives independently

Assign one independent Codex reviewer to each perspective. Run them in waves when concurrency is limited, keeping a coordinator slot free. Use the model and effort required by the repository policy. Do not show reviewers one another's findings.

Whenever the coordinator waits for a native reviewer, set `wait_agent.timeout_ms` explicitly to twice the estimated remaining duration, bounded by the tool minimum and maximum. Use the documented default when no estimate is possible; do not shorten the wait merely to poll.

| Perspective      | Inspect                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| line-scan        | Changed lines and nearby branches, boundaries, exceptions, async behavior, and data integrity |
| removed-behavior | Validation, defaults, cleanup, and error handling removed or replaced                         |
| cross-file       | Actual callers, callees, arguments, results, ordering, errors, and data formats               |
| reuse            | Existing shared behavior missed by the change and concrete drift caused by duplication        |
| simplification   | Unnecessary state, branches, duplication, or dead code with a concrete cost                   |
| efficiency       | Realistic CPU, I/O, network, wait, and retained-memory impact                                 |
| altitude         | Whether the fix is at the correct abstraction and avoids accumulating special cases           |
| conventions      | Explicit violations of rules that apply to the changed paths                                  |

Each reviewer receives the same fixed target, purpose, acceptance criteria, rules, and only its assigned perspective. It may inspect surrounding code and callers. Return at most six evidence-backed candidates; do not fill a quota with preferences or pre-existing unrelated problems.

Each candidate must include an ID, perspective, P0-P3 severity, defect or maintainability kind, minimal location, trigger, effect, affected caller or user, evidence, and remaining uncertainty.

The outer orchestrator runs the repository policy's independent second track against the same fixed target without exposing this track's findings. Return this track's candidates and coverage without claiming repository-level GO. If the orchestrator cannot complete the second track, the combined result is `INCOMPLETE`.

## 3. Consolidate and verify

After every finder finishes, merge only candidates with the same cause and impact, retaining all source IDs. Do not discard candidates by confidence score.

Give every consolidated candidate to a verifier other than its discoverer. Instruct the verifier to seek disproof and return:

- `CONFIRMED`: the trigger and effect are established from code, callers, or a safe reproduction;
- `PLAUSIBLE`: the mechanism exists but a real trigger remains unverified; state the missing check;
- `REFUTED`: existing protection, scope, or reachability evidence disproves it.

Safe focused tests may be requested, but reviewers remain read-only. Batch candidates only if the response preserves a separate verdict and evidence for each.

## 4. Decide and report

Re-check the target SHA, diffs, untracked inventory, and included file hashes. If anything changed, the result applies only to the old snapshot and cannot be GO for the current head.

Return the review report using the repository contract. The invoking orchestrator captures the final response outside the worktree with the CLI output-file option. Include:

1. fixed base/head, scope, worktree state, issue criteria, and completion state;
2. findings ordered by severity with verdict and evidence;
3. candidate counts before/after consolidation and by verdict, all eight perspective statuses, failures, omissions, and undisplayed candidates;
4. blocker classification under the repository policy and `GO`, `NO-GO`, or `INCOMPLETE`;
5. observed models/effort, elapsed time, usage when reported, retry/timeout facts, and limitations.

Label this track `CLEAR` only when all eight Codex perspectives and its target-integrity check are complete. The outer orchestrator alone assigns repository-level GO after the second track, candidate verification, acceptance checks, and validation. Unknown usage is `unknown`, not zero.
