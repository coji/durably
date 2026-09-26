# ADR-0022: local-agent-loop repairs an approved candidate in a new run from outside findings

## Status

accepted

## Context

A repository run of `examples/local-agent-loop` ends when its candidate is approved and delivered (issue #244). Findings often arrive after that: a UI check, a formal review, CI on the pull request. Until now the only ways to act on them were to fix the branch by hand, outside the factory, or to trigger a new run from the original base with the task edited. The first loses the factory's measurement, repair budget, reviews and delivery. The second throws away the approved work and pays to implement it again.

A finished run is a closed record. Its output, its stages and its measurements are what `report` and `compare` read, and Durably has no way to move a terminal run back to pending without rewriting that record. The factory also relies on replay: every stage is a durable step, a replay must never send an uncertain agent call again, and it must not create a second branch or commit.

## Decision

- **A new child run, not a resumed parent.** `demo repair --run <id> --findings-file <path> [--dispositions-file <path>]` triggers a new run of the same job whose input names its parent (`repairOf`). The parent's record is never changed. The child has its own id, stages, measurements, branches and delivery.
- **Which runs may be a parent.** Only a repository run that is `completed`, whose output is `approved`, that recorded a delivery, and whose last candidate commit equals the delivered commit. A rejected, capped, failed, cancelled or waiting run is refused even when it left a candidate. Before anything is created, the CLI checks that the candidate commit exists in the repository and that the recorded candidate branch still points at it; a moved or missing branch starts nothing. The child input stores the branch name, and the child's setup makes the same check again right before it cuts its worktree and branch from the candidate commit, after the CLI probe and before `setupCommand`: the branch can move between the CLI's check and the worker's setup, and `demo retrigger` of a child never goes through `demo repair`. A replayed setup first discards the worktree and branch an earlier attempt left, then checks. A failed check removes the child's run directory and stops the child as `candidate-moved`, with no worktree, branch or run directory left and before any agent call. It is retryable, since no call was sent, and a retry stops the same way until the branch points at the candidate again. The CLI's own check stays for fast feedback. A child that meets the same conditions can be a parent in turn.
- **Settings inherited, frozen at trigger.** The child input is built from the parent's stored input and its setup record: task, spec, issue, the resolved profiles (code, correctness, edge-cases, repair and triage, with their ids and effective model and effort), check and setup commands, both timeouts, `codexPath`, commit and publish settings, auto-approval, context mode and `maxIterations`. A value the parent's setup recorded is inherited as it is, `null` included, so a child and its own children record the parent's settings. The config version is computed from those settings and the CLIs the run actually launches, so it matches the parent's unless a CLI changed or only the parent's triage used a CLI. Only a value the parent's setup predates is taken from the parent's stored input. The triage profile is recorded only: the child never calls or preflights it, and setup does not probe its CLI. One helper decides which triage profile a run really calls, and the setup probe, preflight, triage step and report rows all read it. The worker uses the resolved profiles as stored and never resolves them again; the current `factory.json` and environment variables decide nothing. `repair --reload-config` is refused, and `retrigger --reload-config` of a child is refused too; a person who wants other settings starts a normal run with `trigger`.
- **Findings are untrusted input.** `demo repair` takes only `--run`, `--findings-file` and `--dispositions-file`, and refuses any other flag instead of ignoring it. The findings file, and the optional dispositions file, pass the same checks as trigger's input files (at most 256 KiB, UTF-8, not blank). Their content and the path they were read from are stored in the child input. The findings go to the repairer and both reviewers in a `FINDINGS` block fenced with a hash of its content, like the task and spec. They are never turned into verified feedback or a factory instruction. A child's reviewers are told that the base is an approved candidate and the diff is the repair alone, and to judge whether it addresses the findings without regressing the approved candidate, instead of planning the whole task. Dispositions replace the parent's when given and are inherited otherwise, and still go to the reviewers only.
- **Idempotency.** The idempotency key is the parent run id, the SHA-256 of the stored findings, and the SHA-256 of the dispositions the child really gets. The same content from another path returns the same child; different dispositions make another child.
- **The candidate commit is the base.** The child's `baseRef` and recorded `baseCommit` are the parent's last candidate commit, not the parent's own base and not the current `HEAD`. The iteration branch is `factory/<childRunId>` whether or not the task came from an issue. Candidate diffs, the delivered patch and the single parent of `factory/<childRunId>-squashed` are all taken against that base.
- **Stages and budget.** The child runs setup, preflight and, when configured, the baseline check. It runs no shadow triage and no initial implementation: its first code stage is role `repair`, iteration 1, in a new session in the child's worktree, on the repair profile when one is configured. It never continues the parent's session. After that, verification, both reviews, approval and delivery are the existing stages, and later repairs follow the existing review-note path. `maxIterations` counts the child's own repairs, the first one included, and nothing the parent used.
- **Recovery is the normal run's.** A replayed setup discards and recreates the child's worktree and branch, which is safe because nothing is sealed yet and the base is a fixed commit. Delivery reuses a squashed branch that points at exactly the expected commit and refuses any other, as ADR-0021 decides. An agent call with a start checkpoint and no completion stops the run as uncertain and is never sent again.
- **Reporting.** The child's input records the parent id and candidate commit. `report` (JSON and Markdown) shows the parent id, the child ids, and the findings file's path and SHA-256 of the stored content; `status --run` shows the parent and children; the web UI links both ways by task name, with ids as secondary text. Every path that triggers a child (`demo repair`, `demo retrigger` and the seed) gives it the Durably run label `repairOf=<parentRunId>`. Children are found by that label every time, so a parent report the UI cached when it finished still shows a child added later. A single report (`report`, `status --run`, the CLI's `compare`, the UI's detail page) makes one label query per report. SQLite answers it by walking the job's runs through the job index and probing each run's labels, so one lookup grows linearly with the history. The UI's run list and comparison read every run of the job anyway; they group those runs by their label, falling back to the input's `repairOf`, once per request and pass each report its children, so they make no child query per run and their cost stays linear rather than quadratic. The child's first repair counts as a repair in its summary and usage. `compare` puts repair runs and normal runs in separate groups, keeps grouping repair runs by `configVersion`, and never adds the parent's time, cost or stages to a child.

## Consequences

- Findings found after approval can be repaired inside the factory, with the same measurement, budget, reviews and delivery as any run, and without paying for a new implementation.
- A child's branches and pull request build on the parent's candidate. `--publish` still targets the default branch, so a draft pull request from a child whose parent is not merged also contains the parent's changes.
- A person who moves the parent's candidate branch after approval cannot repair that run; they start a normal run instead. A child already queued, a retried child, or a replayed setup stops as `candidate-moved` and leaves no worktree, branch or run directory.
- A run triggered with a `repairOf` input but without the label is not found as a child. Every trigger path in the example passes it.
- The run input grows an optional `repairOf` field that carries resolved profiles. Normal runs are unchanged, and their `configVersion` does not change.

## Rejected Alternatives

### Resume the finished run

Rejected. It would move a terminal run back to an open state, rewrite the record `report` and `compare` read, and mix two budgets and two sets of measurements in one run. Durably has no supported way to do it, and replay could no longer tell which calls belonged to which pass.

### Fix the findings outside the factory

Rejected. It is what people did, and it loses exactly what the factory exists for: the repair budget, the pinned check, the independent reviews, the measured time and cost, and the delivery record.

### Start a normal run from the original base with the findings added to the task

Rejected. It pays to implement the approved work again, may not reproduce it, and reads the current `factory.json` and environment, so the comparison with the parent no longer holds.

### Check the candidate branch only in the CLI

Rejected. The branch can move between the check and the worker's setup, and a retrigger of a child never makes the check. The worker's setup is the one place every child passes through before it creates its worktree and branch.

### Find children by scanning every run's input

Rejected. It reads every run of the job, input included, for each report, so listing and comparing runs grows with the square of the history. A label names the parent without parsing inputs, a single report asks for it in one query, and a view that has already read every run groups them in one pass.

### Re-resolve the settings from the current factory.json

Rejected. A repair should differ from its parent only in its findings. Letting a config edit or an environment variable in would make the child a different experiment. A deliberate settings change is a normal trigger.
