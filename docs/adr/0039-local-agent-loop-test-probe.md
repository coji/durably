# ADR-0039: local-agent-loop runs a candidate's new and changed tests on the base and on the candidate, and hands the result to the reviewers as trusted context

## Status

accepted

## Context

In `examples/local-agent-loop`, the review rules of a repository run say that a new test which would pass against the base commit does not count, and ask for `needsChanges` when it would. The reviewers cannot check that. A Claude reviewer may only read, a command reviewer gets read and search tools and subagents, and Codex reviews in a read-only sandbox. The review snapshots are trees extracted from commits, without installed dependencies. So a reviewer judges by reading the code whether a test exercises the change.

Issue #307 reports what that costs on artifactshare: more than four in ten of the correctness reviewer's findings say, in some form, that it could not run the tests, and most runs that stopped at the review cap had a correctness reviewer asking for changes in the last round. A reviewer that cannot tell plays safe, and every such `needsChanges` is a repair round.

ADR-0038 added the path for this: a stage reads a file it produced inside its own step, and `withStageContext` registers the settled content for the reviewers' TRUSTED CONTEXT, with a copy outside the worktree that every reviewer may read.

## Decision

- **`testProbe` in `factory.json`, fixed at trigger.** One or more `{ glob, command }` entries. `command` is argv and must have at least one element that is exactly `{files}`; an element that merely contains it is refused, so the path is never split or expanded by a shell or a tool. The value is validated and stored in the run input at trigger, inherited by `retrigger` and by a repair run, and read again only by `--reload-config`, like `selfCheck` and `parallelReview`. It is not part of `configVersion`: it adds a result to the reviews without changing the roles' calls.
- **What runs.** The `added:` and `modified:` lines of the sealed candidate's `changed-files.txt` whose repository-relative path matches a glob (`path.posix.matchesGlob`), each once, with the first entry it matches. Deleted, renamed and copied files never run. Each file runs on its own, with an argv computed once per file by replacing each `{files}` element with its path, so the result is per file. A path that leaves the worktree, through a link included, is recorded as not run.
- **A separate base worktree.** With `testProbe`, setup adds a detached worktree at `baseCommit` beside the agent's, `runs/<id>/base-work`, and runs the same `setupCommand` in it. For each candidate the probe resets it to the base and checks out only the matching test files from the candidate commit, with literal pathspecs, and runs each file there and then on the candidate side, in the agent's worktree, which `assertIntact` proved is the sealed candidate. Afterwards the agent's worktree is reset to the candidate commit, so a test that rewrote a tracked file leaves nothing for the check or the reviews, and `assertIntact` runs again.
- **Failures are results.** A base worktree that cannot be added or set up does not fail setup: it is removed again and its reason stored, and every probe records the base side as not run for that reason while the candidate side still runs. A command that cannot start, or runs past its limit, is recorded as not run with the reason. Each subprocess has the run's `checkTimeoutMs` and an output cap. Only a cancel, a lost lease, or a candidate that no longer matches its seal stops the run.
- **One checkpoint per candidate.** The probe is the verify stage's step `stage:<n>:verify:test-probe`, run before the check, and with `parallelReview` completed before the `step.all` that starts the check and both reviews. Only the verify stage runs or reads that step. Its output is the per-file record, each side's output tail for every file included, and the `test-probe` stage context read inside the step with `readStageContextFile`; a replay after a worker restart reads the output back and runs nothing.
- **The result reaches the reviewers through the run state.** The verify stage's event (`verify.completed`, or `verify-review.completed` with `parallelReview`) carries the settled context. The reducer registers it with `withStageContext`, which replaces an earlier candidate's `test-probe` entry in `setup.target`, and the job builds the target again whenever `setup.target` changes, so the sequential review stage that follows gets a target with it and reads nothing back itself. The verify-review stage reviews within the same stage, so it registers the context the same way and builds its reviewers' target from that setup. Both Codex and Claude reviewers, prompt and command forms alike, get it in the TRUSTED CONTEXT through `prepareStageContext`, as ADR-0038 describes. The result file is written under `runs/<id>/test-probe/`, outside both worktrees.
- **The result is evidence, not a verdict.** The text lists per file the exit code, time and output tail on each side, and one of: failed on the base and passed on the candidate, passed on both, failed on the candidate, could not run. It says so when no file matched. Tails shrink, then files past the first few are left to the count, to keep it within the 32 KiB stage-context limit; the stored record keeps every file's tails whatever the text had room for. The text itself says how to read it: a failure on the base proves nothing about the behaviour when the test only failed to import something the base lacks. The review rules stay generic: when a `test-probe` result is attached, judge the tests from any trusted stage result that covers them and read the code only for a test none covers; without one, the rule is as before.
- **Cleanup.** The base worktree is removed, directory and git registration, when the run ends: when it completes, and with the review snapshots when it fails or is cancelled. A wait for a person, on the spec or on the approval, does not end the run and keeps it, so the probes after a spec wait need no second install; Durably suspends by throwing from `step.waitFor`, so the job tells a suspension from a failure by that error. A lost lease leaves it for the worker that resumes, and a probe that finds it gone makes it again. `removeRunWorktree`, used by an approved delivery, `demo archive` and `demo prune --apply`, removes each of the run's worktrees, the agent's and the base, and prune counts them as one entry.
- **Report.** `testProbes` in the JSON report, and a Test probe section in the Markdown when there is one, give per candidate the number of files, how many failed on the base, the time and the reasons a side could not run, read from the stored steps.

## Consequences

- Reviewers judge whether new tests exercise the change from what the factory saw, and fall back on reading the code only where the probe had nothing to say.
- A run with `testProbe` installs dependencies twice at setup and runs each new test file twice per candidate. The base worktree stays on disk while the run waits for a person.
- The probe's result is trusted by construction: it comes from the factory's own processes, outside the worktree the implementer edits. The test code itself is the candidate's, so it can print anything; that is why the result reports exit codes from the factory and leaves the reading of output to the reviewer.
- A run without `testProbe` has no base worktree, no probe step and the review rule it had.

## Rejected Alternatives

### Run the probe in the base review snapshot, or check out the base in the agent's worktree

Rejected. The snapshots have no dependencies, so the tests could not run there. Switching the agent's worktree to the base and back would put the sealed candidate at risk between the switch and `assertIntact`, and with `parallelReview` the check runs in that worktree.

### Give the reviewers permission to run the tests

Rejected for now, and out of scope of the issue. The reviewers' read-only boundary is what lets them read untrusted candidates safely; a fixed, factory-run probe gives them the one result they most need without widening it.

### Pass all matching files to one invocation

Rejected. One exit code for many files cannot say which test failed on the base, and the reviewer needs that per file.

### Stop the run when the probe cannot run

Rejected. The probe is evidence for the reviewers, not a gate. A run without it is no worse than before, so its failure is written into the result and the report and the run goes on.

### Key the probe step by candidate

Rejected. A step under the verify stage's key keeps the probe's time in the verify stage of the report's timings and visits, and every stage table stays as it was.
