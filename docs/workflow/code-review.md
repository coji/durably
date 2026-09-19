# Code review and Draft PR workflow

This policy governs the review gate between a completed implementation and a pull request becoming Ready for review. The workflow does not use takt.

The review mechanics build on [the eight-perspective Codex review procedure](https://gist.github.com/coji/e4f0a611772d49edfc2e391bcf233b8e): freeze the target, explore perspectives independently, verify each candidate with a different reviewer, and re-check target integrity before GO. This repository adds the independent Opus track and the Draft-to-Ready gate.

## Reviewer topology

Use two independent review tracks against the same fixed commit:

- Codex `gpt-5.6-sol`, reasoning effort `medium`: eight independent perspective reviewers defined by the repository `$code-review` skill, followed by independent candidate verification.
- Claude Opus, effort `high`: the outer orchestrator dispatches an independent pass over all eight perspectives. It must not see Codex candidates before returning its own candidates. Neither finder dispatches the other.

After both finder tracks finish, the orchestrator consolidates candidates. A candidate must be verified by a reviewer that did not discover it. The two tracks may verify one another's candidates. If either required model, any perspective, or required verification is unavailable, the result is `INCOMPLETE` and the PR remains Draft.

Each reviewer call has a ten-minute default limit and one retry for an execution failure. A longer limit must be recorded before retrying. Keep the worktree unchanged during review and retain the fixed snapshot under `$(git rev-parse --git-dir)/durably-review/<pr>/<head-sha>/` and each report under its `round-<n>/` child. Review processes run read-only; the orchestrator creates these directories first and captures final CLI output there.

## Blockers

A review round has a blocker when any of these is true:

- an issue acceptance criterion is unmet or cannot be verified;
- a PR completes a decision that meets the repository ADR criteria but omits the ADR, or leaves the relevant ADR or its index entry as `proposed` (including an ADR already on `main`; proposal-only and partial-implementation PRs remain `proposed`);
- a proposal-only or partial-implementation PR omits its ADR or index entry, or marks either `accepted` before completing the decision;
- a `CONFIRMED` P0 or P1 finding remains;
- a `CONFIRMED` P2 correctness, security, data-integrity, compatibility, or user-visible regression remains;
- a P0 or P1 candidate is `PLAUSIBLE` and its stated verification has not been completed;
- required validation or a check for the reviewed head is failing or pending;
- a required review perspective, independent track, or candidate verification is incomplete;
- the branch changed after the reviewed snapshot was fixed.

P3 findings, suggestions, and refactor-only P2 findings are non-blocking unless they directly contradict an issue acceptance criterion. Record them in the report and PR body so they are not silently lost.

## Draft-to-Ready loop

1. Start from a clean checkout and record the remote-default base SHA before creating the feature branch. Complete implementation, acceptance checks, simplification, supervision, and documentation against the full `base...HEAD` change set. Check the implementation against the ADR criteria and existing proposed ADRs, even if no ADR path changed. If this PR completes the recorded decision, create or update the relevant ADR and index as `accepted` on this branch before opening the Draft PR. Proposal-only PRs create or keep their ADR and index as `proposed`; partial-implementation PRs keep both as `proposed`. Commit and push a clean worktree.
2. Create the PR with `gh pr create --draft`. Link the source issue with `Closes #<number>` when applicable. Record the base and current head SHA in the PR body.
3. Freeze that pushed head and run `$code-review high <PR URL>`. The acceptance table in the review report must state whether the PR completes, partially implements, or proposes an ADR-worthy decision and verify the ADR and index have the corresponding status, including when no ADR path appears in the diff.
4. If the result is `NO-GO`, the orchestrator fixes every blocker, runs focused checks plus the repository validation command, commits, and pushes. Start a new review round for the new head. The first round reviews the full `base...HEAD` diff; later rounds review the delta from the previous reviewed head, its affected callers and invariants, and every unresolved blocker. Carry forward the previous round's verified findings and coverage. Repeat the full-diff review only when the fix changes the feature's scope or architecture, or invalidates the earlier coverage. Do not reuse a previous GO.
5. If the result is `INCOMPLETE`, finish the missing review or validation. Do not change Ready state.
6. When the result is `GO`, wait for every check reported for that exact head to finish successfully. Verify that the remote PR head still equals the reviewed SHA and that the issue acceptance criteria remain satisfied.
7. Update the PR body with the final review summary, then, from the repository root, use `.claude/skills/spec-implement-accept/scripts/mark-ready.sh <PR> <reviewed-sha> <validation-evidence>`. Validation evidence names the exact reviewed SHA and a successful `pnpm validate`. The script re-reads the remote head and check buckets immediately before the mutation, then verifies the head again afterward. An empty check list is allowed only because exact-head local validation is mandatory. If the head moved, restore Draft state and review the new head. Ready is the result of the gate, never a substitute for it.

Post progress after each round without marking the PR Ready. Invoking the end-to-end workflow authorizes creating and updating its Draft PR and marking it Ready only after this gate passes.

## Convergence and stopping

Continue while blocker count decreases or new evidence changes the fix. Never force a GO.

Stop with the PR still Draft when:

- the same root-cause blocker survives three consecutive rounds;
- six review/fix rounds complete without GO;
- a required external service, credential, model, or test environment remains unavailable;
- the fix requires changing issue scope or an architectural decision that needs user input.
- the end-to-end workflow reaches 35 phase transitions or supervision reaches three rounds.

Report the blocking IDs, evidence, attempts, current head, failed or missing checks, and the decision needed to resume.

## Review report contract

Each round writes `round-<n>/code-review-round-<n>.md` outside the worktree with:

```markdown
# Code Review Round N

Base: <ref>@<sha>
Head: <sha>
Issue: <number or none>
Result: GO | NO-GO | INCOMPLETE

## Acceptance criteria

| Criterion | PASS/FAIL/UNKNOWN | Evidence |

## Blocking findings

<!-- ID, severity, verdict, location, trigger, effect, evidence, required action -->

## Non-blocking findings

## Coverage and candidate ledger

<!-- eight perspectives, both tracks, original/consolidated/verdict counts, failures -->

## Validation and checks

## Target integrity

## Execution record

<!-- requested/observed models and effort, elapsed time, reported usage, retries, limits -->
```
